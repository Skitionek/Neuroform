/**
 * The resting synapses: one static, very dim additive line mesh. Tens of
 * thousands of near-invisible wires that only read as a mass, which is exactly
 * what makes the bright pulses legible when they run across it.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  LineSegments,
  ShaderMaterial,
} from 'three';
import type { NetworkGraph } from '../graph/types';
import { PALETTE, tissueColorFor } from './palette';

const vertexShader = /* glsl */ `
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
  readonly lines: LineSegments;
  readonly material: ShaderMaterial;

  constructor(graph: NetworkGraph, options: EdgeLayerOptions = {}) {
    const { opacity = 0.032, tractThreshold = 0.28 } = options;
    const m = graph.edgeCount;

    const positions = new Float32Array(m * 6);
    const colors = new Float32Array(m * 6);
    const fade = new Float32Array(m * 2);

    const tractLength = graph.bounds * tractThreshold;
    const c = new Color();
    const tract = PALETTE.tract;

    for (let e = 0; e < m; e++) {
      const a = graph.edges[e * 2];
      const b = graph.edges[e * 2 + 1];
      const isTract = graph.edgeLength[e] > tractLength;

      for (let v = 0; v < 2; v++) {
        const node = v === 0 ? a : b;
        const po = (e * 2 + v) * 3;
        positions[po] = graph.positions[node * 3];
        positions[po + 1] = graph.positions[node * 3 + 1];
        positions[po + 2] = graph.positions[node * 3 + 2];

        c.copy(tissueColorFor(graph.region[node]));
        if (isTract) c.lerp(tract, 0.45);
        colors[po] = c.r;
        colors[po + 1] = c.g;
        colors[po + 2] = c.b;

        // Deep wires recede; long tracts stay readable so the midline
        // crossings are visible as structure rather than noise.
        fade[e * 2 + v] = (isTract ? 0.85 : 1) * (1 - 0.55 * graph.depth[node]);
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new BufferAttribute(colors, 3));
    geometry.setAttribute('aFade', new BufferAttribute(fade, 1));
    geometry.computeBoundingSphere();

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uOpacity: { value: opacity } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.lines = new LineSegments(geometry, this.material);
    this.lines.frustumCulled = false;
  }

  setOpacity(value: number): void {
    this.material.uniforms.uOpacity.value = value;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.material.dispose();
  }
}
