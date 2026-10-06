/**
 * The resting synapses: very dim additive lines. Tens of thousands of
 * near-invisible wires that only read as a mass, which is exactly what makes
 * the bright pulses legible when they run across it.
 *
 * Local synapses are an index buffer over the node layer's own attributes:
 * positions, colours and depths already live on the GPU once, so each edge
 * costs two indices instead of two copies of everything. Long-range tracts
 * are tinted differently, so they are a separate (small) mesh.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineSegments,
  ShaderMaterial,
} from 'three';
import type { NetworkGraph } from '../graph/types';
import { PALETTE, tissueColorFor } from './palette';

/** Local synapses: colour and fade derived from the shared node attributes. */
const localVertex = /* glsl */ `
  attribute vec3 aTissue;
  attribute float aDepth;
  varying vec3 vColor;
  varying float vFade;

  void main() {
    vColor = aTissue;
    // Deep wires recede so the surface structure reads first.
    vFade = 1.0 - 0.55 * aDepth;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Long-range tracts: colour and fade baked per vertex. */
const tractVertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aFade;
  varying vec3 vColor;
  varying float vFade;

  void main() {
    vColor = aColor;
    vFade = aFade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vFade;

  void main() {
    gl_FragColor = vec4(vColor * vFade, uOpacity * vFade);
  }
`;

export interface EdgeLayerOptions {
  opacity?: number;
  /** Edges longer than this fraction of the cloud radius count as tracts. */
  tractThreshold?: number;
}

export class EdgeLayer {
  readonly object = new Group();
  private materials: ShaderMaterial[] = [];
  private geometries: BufferGeometry[] = [];

  /**
   * @param nodes the node layer's geometry, whose position, aTissue and aDepth
   * attributes are shared rather than copied.
   */
  constructor(graph: NetworkGraph, nodes: BufferGeometry, options: EdgeLayerOptions = {}) {
    const { opacity = 0.032, tractThreshold = 0.28 } = options;
    const m = graph.edgeCount;
    const tractLength = graph.bounds * tractThreshold;

    let tracts = 0;
    for (let e = 0; e < m; e++) if (graph.edgeLength[e] > tractLength) tracts++;

    // Local synapses, indexed into the node attributes.
    const IndexArray = graph.nodeCount <= 65535 ? Uint16Array : Uint32Array;
    const index = new IndexArray((m - tracts) * 2);
    // Tracts, baked.
    const tractPositions = new Float32Array(tracts * 6);
    const tractColors = new Float32Array(tracts * 6);
    const tractFade = new Float32Array(tracts * 2);

    const c = new Color();
    let li = 0;
    let ti = 0;
    for (let e = 0; e < m; e++) {
      const a = graph.edges[e * 2];
      const b = graph.edges[e * 2 + 1];
      if (graph.edgeLength[e] <= tractLength) {
        index[li++] = a;
        index[li++] = b;
        continue;
      }
      for (let v = 0; v < 2; v++) {
        const node = v === 0 ? a : b;
        const o = (ti * 2 + v) * 3;
        tractPositions[o] = graph.positions[node * 3];
        tractPositions[o + 1] = graph.positions[node * 3 + 1];
        tractPositions[o + 2] = graph.positions[node * 3 + 2];
        // Tracts carry a violet tint and stay readable, so the midline
        // crossings read as structure rather than noise.
        c.copy(tissueColorFor(graph.region[node])).lerp(PALETTE.tract, 0.45);
        tractColors[o] = c.r;
        tractColors[o + 1] = c.g;
        tractColors[o + 2] = c.b;
        tractFade[ti * 2 + v] = 0.85 * (1 - 0.55 * graph.depth[node]);
      }
      ti++;
    }

    const local = new BufferGeometry();
    local.setAttribute('position', nodes.getAttribute('position'));
    local.setAttribute('aTissue', nodes.getAttribute('aTissue'));
    local.setAttribute('aDepth', nodes.getAttribute('aDepth'));
    local.setIndex(new BufferAttribute(index, 1));
    this.add(local, localVertex, opacity);

    if (tracts > 0) {
      const tract = new BufferGeometry();
      tract.setAttribute('position', new BufferAttribute(tractPositions, 3));
      tract.setAttribute('aColor', new BufferAttribute(tractColors, 3));
      tract.setAttribute('aFade', new BufferAttribute(tractFade, 1));
      this.add(tract, tractVertex, opacity);
    }
  }

  private add(geometry: BufferGeometry, vertexShader: string, opacity: number): void {
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uOpacity: { value: opacity } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const lines = new LineSegments(geometry, material);
    lines.frustumCulled = false;
    this.object.add(lines);
    this.geometries.push(geometry);
    this.materials.push(material);
  }

  setOpacity(value: number): void {
    for (const m of this.materials) m.uniforms.uOpacity.value = value;
  }

  /**
   * Disposes the edge-only resources. The local geometry's shared node
   * attributes are left to the node layer: disposing a geometry in three.js
   * frees the GL buffers of every attribute on it, so the shared ones are
   * detached first.
   */
  dispose(): void {
    for (const g of this.geometries) {
      if (g.index) {
        g.deleteAttribute('position');
        g.deleteAttribute('aTissue');
        g.deleteAttribute('aDepth');
      }
      g.dispose();
    }
    for (const m of this.materials) m.dispose();
  }
}
