/**
 * The activation model.
 *
 * Highlighting a node makes it fire. Firing launches a pulse down every synapse
 * that holds (reliability is per-edge), each pulse travelling at a finite speed
 * so long wires arrive late. On arrival a pulse deposits charge; charge leaks
 * away continuously; a node that crosses threshold fires in turn and then sits
 * refractory for a moment, which is what keeps the wave moving outward instead
 * of sloshing back and forth forever.
 *
 * The simulation is event-driven: a frame costs time proportional to the
 * pulses that arrive and the nodes that fire in it, not to the size of the
 * network. Decay is never stepped. Charge is decayed lazily when a pulse
 * lands, and glow is stored as (peak, start time) and decayed on the GPU.
 */
import { DirtySet } from '../core/dirty';
import { Rng } from '../core/rng';
import type { NetworkGraph } from '../graph/types';

export interface SimParams {
  /** Pulse travel speed, model units per second. */
  speed: number;
  /** Charge needed to fire. */
  threshold: number;
  /** Charge delivered by one arriving pulse, before edge weight. */
  gain: number;
  /** Charge half-life, seconds. */
  decay: number;
  /** Dead time after firing, seconds. */
  refractory: number;
  /** Global multiplier on per-edge reliability. */
  reliability: number;
  /**
   * Distance over which a signal fades to 1/e of its strength, in model units.
   * Decay is per unit travelled rather than per hop, so how far a wave spreads
   * stays the same whether the cloud has 5,000 points or 100,000.
   */
  range: number;
  /** Visible afterglow half-life, seconds. */
  glow: number;
  /** Spontaneous firings per second across the whole network. */
  spontaneous: number;
  /** Visual-only flickers per second. Sparkle without triggering a wave. */
  shimmer: number;
  /** Hard cap on pulses in flight. */
  maxPulses: number;
}

export const DEFAULT_PARAMS: SimParams = {
  speed: 0.5,
  // Threshold sits just under the charge a strong synapse delivers, so a
  // healthy connection fires its neighbour outright while a weak one has to
  // arrive alongside another to count. With synapses this unreliable, that
  // mix is what gives the wave front its ragged, branching edge.
  threshold: 0.45,
  gain: 0.63,
  decay: 0.96,
  refractory: 0.46,
  reliability: 0.39,
  // Signals meander rather than travelling straight, so the useful range runs
  // past the cloud's own diameter.
  range: 2.75,
  glow: 0.65,
  spontaneous: 0.5,
  shimmer: 140,
  maxPulses: 24000,
};

/** Glow below this reads as zero, on the CPU and in the shader alike. */
export const GLOW_FLOOR = 0.002;

/**
 * Sim time is rebased to zero this often. Times live in float32 on the GPU,
 * and at an hour float32 resolution is still a fraction of a millisecond.
 */
const REBASE_AFTER = 1024;

/**
 * Pulses in flight.
 *
 * Render data lives in compact slots [0, count) so the GPU can draw exactly
 * `count` instances; removal swaps the last slot into the hole. Each pulse
 * also has a stable id, which is what the arrival heap refers to, so slot
 * shuffling never invalidates the schedule. A pulse's GPU data is written once
 * when it spawns (and again only if it is moved by a removal): its position
 * along the wire is computed in the shader from the current time.
 */
export class PulsePool {
  readonly capacity: number;
  count = 0;

  /** Per slot: [from node, to node], for the GPU. */
  readonly ends: Float32Array;
  /** Per slot: [start time, duration, amplitude], for the GPU. */
  readonly timing: Float32Array;
  /** Slots whose GPU data changed since the last upload. */
  readonly dirty: DirtySet;

  private edge: Uint32Array;
  private slotId: Int32Array;
  private idSlot: Int32Array;
  private freeIds: Int32Array;
  private freeTop: number;

  // Min-heap of pulse ids keyed by arrival time.
  private heapId: Int32Array;
  private heapKey: Float64Array;
  private heapSize = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.ends = new Float32Array(capacity * 2);
    this.timing = new Float32Array(capacity * 3);
    this.dirty = new DirtySet(capacity);
    this.edge = new Uint32Array(capacity);
    this.slotId = new Int32Array(capacity);
    this.idSlot = new Int32Array(capacity);
    this.freeIds = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this.freeIds[i] = capacity - 1 - i;
    this.freeTop = capacity;
    this.heapId = new Int32Array(capacity);
    this.heapKey = new Float64Array(capacity);
  }

  get full(): boolean {
    return this.count >= this.capacity;
  }

  clear(): void {
    this.count = 0;
    this.heapSize = 0;
    for (let i = 0; i < this.capacity; i++) this.freeIds[i] = this.capacity - 1 - i;
    this.freeTop = this.capacity;
    this.dirty.markAll();
  }

  spawn(edge: number, from: number, to: number, start: number, duration: number, amplitude: number): void {
    const id = this.freeIds[--this.freeTop];
    const slot = this.count++;
    this.edge[slot] = edge;
    this.ends[slot * 2] = from;
    this.ends[slot * 2 + 1] = to;
    this.timing[slot * 3] = start;
    this.timing[slot * 3 + 1] = duration;
    this.timing[slot * 3 + 2] = amplitude;
    this.slotId[slot] = id;
    this.idSlot[id] = slot;
    this.dirty.mark(slot);
    this.heapPush(id, start + duration);
  }

  /** Arrival time of the next pulse to land, or Infinity. */
  get nextArrival(): number {
    return this.heapSize > 0 ? this.heapKey[0] : Infinity;
  }

  /**
   * Removes the next pulse to land, reporting it through `out`
   * as [to node, edge, amplitude].
   */
  popNext(out: Float64Array): void {
    const id = this.heapPop();
    const slot = this.idSlot[id];
    out[0] = this.ends[slot * 2 + 1];
    out[1] = this.edge[slot];
    out[2] = this.timing[slot * 3 + 2];

    const last = --this.count;
    if (slot !== last) {
      const moved = this.slotId[last];
      this.edge[slot] = this.edge[last];
      this.ends[slot * 2] = this.ends[last * 2];
      this.ends[slot * 2 + 1] = this.ends[last * 2 + 1];
      this.timing[slot * 3] = this.timing[last * 3];
      this.timing[slot * 3 + 1] = this.timing[last * 3 + 1];
      this.timing[slot * 3 + 2] = this.timing[last * 3 + 2];
      this.slotId[slot] = moved;
      this.idSlot[moved] = slot;
      this.dirty.mark(slot);
    }
    this.freeIds[this.freeTop++] = id;
  }

  /** Shifts every time by -offset, for rebasing the clock. */
  shiftTime(offset: number): void {
    for (let s = 0; s < this.count; s++) this.timing[s * 3] -= offset;
    for (let h = 0; h < this.heapSize; h++) this.heapKey[h] -= offset;
    this.dirty.markAll();
  }

  private heapPush(id: number, key: number): void {
    const { heapId, heapKey } = this;
    let i = this.heapSize++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapKey[p] <= key) break;
      heapId[i] = heapId[p];
      heapKey[i] = heapKey[p];
      i = p;
    }
    heapId[i] = id;
    heapKey[i] = key;
  }

  private heapPop(): number {
    const { heapId, heapKey } = this;
    const top = heapId[0];
    const n = --this.heapSize;
    if (n > 0) {
      const id = heapId[n];
      const key = heapKey[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && heapKey[r] < heapKey[l] ? r : l;
        if (heapKey[c] >= key) break;
        heapId[i] = heapId[c];
        heapKey[i] = heapKey[c];
        i = c;
      }
      heapId[i] = id;
      heapKey[i] = key;
    }
    return top;
  }
}

/** Seed of the simulation's random stream (synapse reliability, idle firing). */
const RNG_SEED = 1337;

export class NetworkSim {
  readonly graph: NetworkGraph;
  params: SimParams;

  /**
   * Per node [peak, start time]. Visible glow at time t is
   * peak * 0.5^((t - start) / params.glow). Shared with the GPU as-is.
   */
  readonly glow: Float32Array;
  /** Nodes whose glow entry changed since the last upload. */
  readonly glowDirty: DirtySet;
  /** Further consumers of glow changes, each draining its own set. */
  private glowWatchers: DirtySet[] = [];
  readonly pulses: PulsePool;

  private charge: Float32Array;
  private chargeAt: Float32Array;
  private lastFire: Float32Array;
  private time = 0;
  private rng = new Rng(RNG_SEED);
  private arrival = new Float64Array(3);

  /** Rolling counters for the readout. */
  stats = { firings: 0, pulses: 0, dropped: 0 };

  constructor(graph: NetworkGraph, params: SimParams = DEFAULT_PARAMS) {
    this.graph = graph;
    this.params = { ...params };

    const n = graph.nodeCount;
    this.glow = new Float32Array(n * 2);
    this.glowDirty = new DirtySet(n);
    this.charge = new Float32Array(n);
    this.chargeAt = new Float32Array(n);
    this.lastFire = new Float32Array(n).fill(-1e9);
    this.pulses = new PulsePool(Math.max(1024, params.maxPulses));
  }

  /** A DirtySet of glow changes for another GPU copy of `glow`; starts all-dirty. */
  watchGlow(): DirtySet {
    const set = new DirtySet(this.graph.nodeCount);
    this.glowWatchers.push(set);
    return set;
  }

  unwatchGlow(set: DirtySet): void {
    this.glowWatchers = this.glowWatchers.filter((s) => s !== set);
  }

  private markAllGlow(): void {
    this.glowDirty.markAll();
    for (const set of this.glowWatchers) set.markAll();
  }

  /** Current sim time. Rebased periodically; only differences are meaningful. */
  get now(): number {
    return this.time;
  }

  get livePulses(): number {
    return this.pulses.count;
  }

  /** Visible glow of a node right now, in [0, 1]. */
  glowAt(node: number): number {
    const peak = this.glow[node * 2];
    if (peak === 0) return 0;
    // 0.5^(elapsed / half-life), as exp: several times cheaper than Math.pow,
    // and this runs for every arrival and firing.
    const g = peak * Math.exp((this.time - this.glow[node * 2 + 1]) * this.glowRate);
    return g < GLOW_FLOOR ? 0 : g;
  }

  /** -ln 2 / half-life, refreshed each step so live param edits apply. */
  private glowRate = -Math.LN2 / DEFAULT_PARAMS.glow;

  /**
   * Clears all activity, leaving the wiring alone, and reseeds the random
   * stream, so the same stimuli after a reset play out the same way.
   */
  reset(): void {
    this.rng = new Rng(RNG_SEED);
    this.charge.fill(0);
    this.chargeAt.fill(0);
    this.lastFire.fill(-1e9);
    this.glow.fill(0);
    this.markAllGlow();
    this.pulses.clear();
    this.stats.firings = 0;
    this.stats.pulses = 0;
    this.stats.dropped = 0;
  }

  /** Makes a node fire now, regardless of its charge. This is the user's poke. */
  stimulate(node: number, amplitude = 1): void {
    if (node < 0 || node >= this.graph.nodeCount) return;
    this.fire(node, amplitude);
  }

  private setGlow(node: number, value: number): void {
    this.glow[node * 2] = value;
    this.glow[node * 2 + 1] = this.time;
    this.glowDirty.mark(node);
    for (const set of this.glowWatchers) set.mark(node);
  }

  private fire(node: number, amplitude: number): void {
    const { graph, params, pulses } = this;
    this.lastFire[node] = this.time;
    this.charge[node] = 0;
    this.chargeAt[node] = this.time;
    this.setGlow(node, Math.max(this.glowAt(node), Math.min(1, amplitude)));
    this.stats.firings++;

    const start = graph.adjOffset[node];
    const end = graph.adjOffset[node + 1];
    const speed = Math.max(0.01, params.speed);
    for (let k = start; k < end; k++) {
      const edge = graph.adjEdge[k];

      // Synapses are unreliable, which is most of what keeps the wave ragged.
      if (this.rng.next() > graph.edgeWeight[edge] * params.reliability) continue;

      if (pulses.full) {
        this.stats.dropped++;
        break;
      }

      // A floor on duration keeps very short synapses from arriving in zero
      // frames, which would read as an instantaneous flash rather than a wave.
      const duration = Math.max(0.016, graph.edgeLength[edge] / speed);
      // Amplitude is the signal's own strength and is NOT scaled by the
      // synapse here: edge weight is applied once, to the charge delivered on
      // arrival. Folding it in twice compounds per hop and starves the wave
      // after three or four steps.
      pulses.spawn(edge, node, graph.adjPeer[k], this.time, duration, amplitude);
      this.stats.pulses++;
    }
  }

  step(dt: number): void {
    const { graph, params, pulses, arrival } = this;
    // Clamp the step so a backgrounded tab doesn't resume with one giant jump.
    // 0.1 s still lets the renderer rest at 10 fps without slowing time down.
    const step = Math.min(0.1, Math.max(0, dt));
    this.time += step;
    const now = this.time;
    this.glowRate = -Math.LN2 / Math.max(0.01, params.glow);
    const leakRate = -Math.LN2 / Math.max(0.01, params.decay);
    const rangeRate = -1 / Math.max(0.01, params.range);

    // Land every pulse due by now, in arrival order. Firings triggered here
    // spawn pulses that arrive strictly later, so this loop terminates.
    while (pulses.nextArrival <= now) {
      pulses.popNext(arrival);
      const target = arrival[0];
      const edge = arrival[1];
      const amp = arrival[2];

      if (now - this.lastFire[target] < params.refractory) continue;

      // Charge leaks continuously; apply the leak since the last touch now.
      const leaked = this.charge[target] * Math.exp((now - this.chargeAt[target]) * leakRate);
      const charge = leaked + params.gain * amp * graph.edgeWeight[edge];
      this.charge[target] = charge;
      this.chargeAt[target] = now;

      // Arriving signal is visible even when it fails to trigger a firing:
      // the dim flicker ahead of the front is the network thinking about it.
      this.setGlow(target, Math.min(1, this.glowAt(target) + 0.22 * amp));

      if (charge >= params.threshold) {
        // Signal fades with the distance it travelled, so waves run out of
        // strength instead of ringing around the network forever.
        const faded = amp * Math.exp(graph.edgeLength[edge] * rangeRate);
        this.fire(target, faded);
      }
    }

    const n = graph.nodeCount;
    // Idle chatter, so a network nobody is touching still looks alive. A
    // spontaneous firing starts a real wave, so it stays rare.
    if (params.spontaneous > 0 && this.rng.next() < params.spontaneous * step) {
      this.fire(this.rng.int(0, n - 1), 1);
    }

    // Shimmer is glow only: no charge, no firing, no wave. It is what keeps a
    // resting network from looking like a still image.
    let flickers = params.shimmer * step;
    while (flickers > 0) {
      if (flickers < 1 && this.rng.next() > flickers) break;
      const i = this.rng.int(0, n - 1);
      this.setGlow(i, Math.min(1, this.glowAt(i) + this.rng.range(0.06, 0.3)));
      flickers -= 1;
    }

    if (this.time > REBASE_AFTER) this.rebase();
  }

  /** Shifts the clock back to zero, keeping every relative time intact. */
  private rebase(): void {
    const offset = this.time;
    this.time = 0;
    const n = this.graph.nodeCount;
    for (let i = 0; i < n; i++) {
      this.glow[i * 2 + 1] -= offset;
      this.chargeAt[i] -= offset;
      this.lastFire[i] -= offset;
    }
    this.markAllGlow();
    this.pulses.shiftTime(offset);
  }
}
