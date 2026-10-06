/**
 * The activation model.
 *
 * Highlighting a node makes it fire. Firing launches a pulse down every synapse
 * that holds (reliability is per-edge), each pulse travelling at a finite speed
 * so long wires arrive late. On arrival a pulse deposits charge; charge leaks
 * away continuously; a node that crosses threshold fires in turn and then sits
 * refractory for a moment, which is what keeps the wave moving outward instead
 * of sloshing back and forth forever.
 */
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
  // Threshold sits just under the charge one strong synapse delivers, so a
  // healthy connection fires its neighbour outright while a weak or attenuated
  // one has to arrive alongside another to count. That mix is what gives the
  // wave front its ragged edge.
  threshold: 0.55,
  gain: 1,
  decay: 0.35,
  refractory: 0.9,
  reliability: 0.9,
  // Signals meander rather than travelling straight, so the useful range runs
  // past the cloud's own diameter. At this value one click sweeps roughly four
  // fifths of the brain over about five seconds, then the network goes quiet.
  range: 2,
  glow: 0.65,
  spontaneous: 0.12,
  shimmer: 140,
  maxPulses: 24000,
};

export interface PulseView {
  count: number;
  /** Edge index per live pulse. */
  edge: Uint32Array;
  /** Travel progress in [0, 1), measured from `from` towards `to`. */
  progress: Float32Array;
  /** Source node, so the renderer knows which way the light moves. */
  from: Uint32Array;
  to: Uint32Array;
  /** Signal amplitude, 1 at launch and lower down weak synapses. */
  amplitude: Float32Array;
}

export class NetworkSim {
  readonly graph: NetworkGraph;
  params: SimParams;

  /** Visible glow per node in [0, 1]; what the point shader reads. */
  readonly activation: Float32Array;

  private charge: Float32Array;
  private lastFire: Float32Array;
  private time = 0;
  private rng = new Rng(1337);

  // Pulses in flight, stored as parallel arrays with swap-removal.
  private pEdge: Uint32Array;
  private pFrom: Uint32Array;
  private pTo: Uint32Array;
  private pStart: Float32Array;
  private pDuration: Float32Array;
  private pAmplitude: Float32Array;
  private pCount = 0;

  private view: PulseView;

  /** Rolling counters for the readout. */
  stats = { firings: 0, pulses: 0, dropped: 0 };

  constructor(graph: NetworkGraph, params: SimParams = DEFAULT_PARAMS) {
    this.graph = graph;
    this.params = { ...params };

    const n = graph.nodeCount;
    this.activation = new Float32Array(n);
    this.charge = new Float32Array(n);
    this.lastFire = new Float32Array(n).fill(-1e9);

    const cap = Math.max(1024, params.maxPulses);
    this.pEdge = new Uint32Array(cap);
    this.pFrom = new Uint32Array(cap);
    this.pTo = new Uint32Array(cap);
    this.pStart = new Float32Array(cap);
    this.pDuration = new Float32Array(cap);
    this.pAmplitude = new Float32Array(cap);

    this.view = {
      count: 0,
      edge: new Uint32Array(cap),
      progress: new Float32Array(cap),
      from: new Uint32Array(cap),
      to: new Uint32Array(cap),
      amplitude: new Float32Array(cap),
    };
  }

  get now(): number {
    return this.time;
  }

  get livePulses(): number {
    return this.pCount;
  }

  /** Clears all activity, leaving the wiring alone. */
  reset(): void {
    this.charge.fill(0);
    this.lastFire.fill(-1e9);
    this.activation.fill(0);
    this.pCount = 0;
    this.view.count = 0;
    this.stats.firings = 0;
    this.stats.pulses = 0;
    this.stats.dropped = 0;
  }

  /** Makes a node fire now, regardless of its charge. This is the user's poke. */
  stimulate(node: number, amplitude = 1): void {
    if (node < 0 || node >= this.graph.nodeCount) return;
    this.fire(node, amplitude);
  }

  private fire(node: number, amplitude: number): void {
    const { graph, params } = this;
    this.lastFire[node] = this.time;
    this.charge[node] = 0;
    this.activation[node] = Math.max(this.activation[node], Math.min(1, amplitude));
    this.stats.firings++;

    const start = graph.adjOffset[node];
    const end = graph.adjOffset[node + 1];
    for (let k = start; k < end; k++) {
      const edge = graph.adjEdge[k];
      const peer = graph.adjPeer[k];

      // Synapses are unreliable, which is most of what keeps the wave ragged.
      if (this.rng.next() > graph.edgeWeight[edge] * params.reliability) continue;

      if (this.pCount >= this.pEdge.length) {
        this.stats.dropped++;
        break;
      }

      const i = this.pCount++;
      const length = graph.edgeLength[edge];
      this.pEdge[i] = edge;
      this.pFrom[i] = node;
      this.pTo[i] = peer;
      this.pStart[i] = this.time;
      // A floor on duration keeps very short synapses from arriving in zero
      // frames, which would read as an instantaneous flash rather than a wave.
      this.pDuration[i] = Math.max(0.016, length / Math.max(0.01, params.speed));
      // Amplitude is the signal's own strength and is NOT scaled by the
      // synapse here: edge weight is applied once, to the charge delivered on
      // arrival. Folding it in twice compounds per hop and starves the wave
      // after three or four steps.
      this.pAmplitude[i] = amplitude;
      this.stats.pulses++;
    }
  }

  private removePulse(i: number): void {
    const last = --this.pCount;
    if (i !== last) {
      this.pEdge[i] = this.pEdge[last];
      this.pFrom[i] = this.pFrom[last];
      this.pTo[i] = this.pTo[last];
      this.pStart[i] = this.pStart[last];
      this.pDuration[i] = this.pDuration[last];
      this.pAmplitude[i] = this.pAmplitude[last];
    }
  }

  step(dt: number): void {
    const { graph, params } = this;
    // Clamp the step so a backgrounded tab doesn't resume with one giant jump.
    const step = Math.min(0.05, Math.max(0, dt));
    this.time += step;

    const chargeKeep = Math.pow(0.5, step / Math.max(0.01, params.decay));
    const glowKeep = Math.pow(0.5, step / Math.max(0.01, params.glow));

    const n = graph.nodeCount;
    for (let i = 0; i < n; i++) {
      this.charge[i] *= chargeKeep;
      const a = this.activation[i] * glowKeep;
      this.activation[i] = a < 0.002 ? 0 : a;
    }

    // Advance pulses, delivering the ones that land this frame. Firings append
    // to the end of the pulse array, so the loop walks a moving target on
    // purpose: new pulses are simply picked up next frame.
    const arrivals: number[] = [];
    for (let i = this.pCount - 1; i >= 0; i--) {
      if (this.time - this.pStart[i] >= this.pDuration[i]) {
        arrivals.push(this.pTo[i], i, this.pEdge[i]);
      }
    }
    for (let a = 0; a < arrivals.length; a += 3) {
      const target = arrivals[a];
      const idx = arrivals[a + 1];
      const edgeOf = arrivals[a + 2];
      const amp = this.pAmplitude[idx];
      this.removePulse(idx);

      if (this.time - this.lastFire[target] < params.refractory) continue;
      this.charge[target] += params.gain * amp * graph.edgeWeight[edgeOf];
      // Arriving signal is visible even when it fails to trigger a firing:
      // the dim flicker ahead of the front is the network thinking about it.
      this.activation[target] = Math.min(1, this.activation[target] + 0.22 * amp);
      if (this.charge[target] >= params.threshold) {
        // Signal fades with the distance it travelled, so waves run out of
        // strength instead of ringing around the network forever.
        const travelled = graph.edgeLength[edgeOf];
        const faded = amp * Math.exp(-travelled / Math.max(0.01, params.range));
        this.fire(target, faded);
      }
    }

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
      this.activation[i] = Math.min(1, this.activation[i] + this.rng.range(0.06, 0.3));
      flickers -= 1;
    }

    this.buildView();
  }

  private buildView(): void {
    const v = this.view;
    for (let i = 0; i < this.pCount; i++) {
      const t = (this.time - this.pStart[i]) / this.pDuration[i];
      v.edge[i] = this.pEdge[i];
      v.from[i] = this.pFrom[i];
      v.to[i] = this.pTo[i];
      v.progress[i] = t < 0 ? 0 : t > 1 ? 1 : t;
      v.amplitude[i] = this.pAmplitude[i];
    }
    v.count = this.pCount;
  }

  /** Live pulses, valid until the next `step`. */
  get pulses(): PulseView {
    return this.view;
  }
}
