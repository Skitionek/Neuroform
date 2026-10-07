/**
 * Neurons as soft, merging cells: the WebGL form of the CSS "gooey" recipe
 * (blur, then threshold alpha with feColorMatrix "... 0 0 0 18 -6").
 *
 * 1. Somas and neurites are drawn as soft density into a half-resolution
 *    buffer. Each soma is a gaussian splat whose radius wobbles with a few
 *    slow harmonics of angle (the morphing border-radius blob); each neurite
 *    is a soft tube, thick where it meets a soma and thin in the middle.
 *    Densities add, so where a neurite meets its soma they sum into a neck.
 *    The merge is depth-aware: a pre-pass writes the depth of each blob's
 *    solid core, and the density pass is depth-tested against it with a
 *    small slack, so only blobs within about two cell radii of the nearest
 *    surface add up. Without it, nodes at different depths that merely
 *    overlap on screen fused into solid lace wherever the shell is seen
 *    edge-on. (The visibility pass of point-based surface splatting.)
 * 2. A full-screen pass thresholds that density the way the CSS matrix does
 *    (alpha' = 18a - 6, a ramp from a = 1/3 to ~0.39) and lights a rim just
 *    inside the edge, so each cell reads as a membrane. The result is added
 *    over the scene before bloom, so firing cells glow.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  DataTexture,
  HalfFloatType,
  LessEqualDepth,
  LinearFilter,
  Mesh,
  NoBlending,
  OneFactor,
  Points,
  RGFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type { NeuronLayout } from '../graph/neurons';
import type { DirtySet } from '../core/dirty';
import type { NetworkSim } from '../sim/network';
import type { GpuTimer } from './gpu-timer';
import {
  DATA_TEXTURE_WIDTH,
  NODE_FETCH_GLSL,
  floatTexture,
  setPulledBounds,
  vertexCountCarrier,
  type NodeTextures,
} from './node-textures';
import { PALETTE } from './palette';

/**
 * Cells are drawn only on the half of the brain facing the camera. The
 * gooey threshold works in screen space, so cells on the far side would fuse
 * with the near ones through the brain; instead they fade out toward the
 * plane through the centre. The fade is on density, so a cell shrinks below
 * the threshold smoothly as the brain turns rather than popping out.
 */
const NEAR_FADE_GLSL = /* glsl */ `
  float nearFade(vec3 p) {
    float side = dot(p - uCentre, uViewDir);
    return smoothstep(-0.02, 0.12, side);
  }
`;

/** Smallest typical cell radius, in density pixels, before resolution drops. */
const MIN_CELL_PX = 2.5;

/** Splat extent in soma radii: covers the gaussian tail plus the wobble. */
const SPRITE = 2.6;
const LN3 = Math.log(3).toFixed(6);

// Density sums with plain addition; colour is premultiplied by density.
const additive = { blending: CustomBlending, blendSrc: OneFactor, blendDst: OneFactor, depthTest: false, depthWrite: false, transparent: true } as const;
/** Density: summed, but only near the front surface laid down by the pre-pass. */
const densityParams = { ...additive, depthTest: true, depthFunc: LessEqualDepth } as const;
/** Depth pre-pass: opaque, depth only. */
const depthParams = { blending: NoBlending, colorWrite: false, depthTest: true, depthWrite: true, transparent: false, defines: { DEPTH_PREPASS: '' } } as const;

const somaVertex = /* glsl */ `
  attribute vec2 aGlow;
  attribute vec3 aTissue;
  attribute float aSeed;
  attribute float aDepth;
  uniform float uTime;
  uniform float uGlowHalfLife;
  uniform float uRadius;
  uniform float uProjScale;
  uniform vec3 uCentre;
  uniform vec3 uViewDir;
  uniform float uDepthSlack;
  varying vec3 vColor;
  varying float vSeed;
  varying float vFade;

  ${NEAR_FADE_GLSL}

  void main() {
    vFade = nearFade(position);
    if (vFade <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec4 placed = mv;
    #ifndef DEPTH_PREPASS
    // Pulled toward the camera by the slack, so the depth test keeps this
    // splat if it lies within the slack behind the front surface.
    placed.z += uDepthSlack;
    #endif
    gl_Position = projectionMatrix * placed;
    float act = aGlow.x * exp2(-max(0.0, uTime - aGlow.y) / uGlowHalfLife);
    act = act < 0.002 ? 0.0 : min(act, 1.0);
    // Cells vary in size, and swell a little when they fire.
    float r = uRadius * (0.9 + 0.6 * aSeed) * (1.0 + 0.3 * act);
    // At least ~1.5 px across, so small distant cells stay visible.
    float rPx = max(r * uProjScale / max(0.05, -mv.z), 0.75);
    gl_PointSize = 2.0 * ${SPRITE.toFixed(2)} * rPx;
    vColor = mix(aTissue * (0.8 + 0.4 * (1.0 - aDepth)), SIGNAL, act);
    vSeed = aSeed;
  }
`;

const somaFragment = /* glsl */ `
  uniform float uTime;
  varying vec3 vColor;
  varying float vSeed;
  varying float vFade;

  void main() {
    vec2 p = (gl_PointCoord - 0.5) * 2.0 * ${SPRITE.toFixed(2)}; // in soma radii
    float r = length(p);
    float th = atan(p.y, p.x);
    float ph = vSeed * 6.2831853;
    // A few slow harmonics of angle: the morphing border-radius blob.
    float m = 1.0
      + 0.16 * sin(3.0 * th + ph + uTime * 0.6)
      + 0.09 * sin(5.0 * th - 1.7 * ph - uTime * 0.45)
      + 0.05 * sin(2.0 * th + 2.3 * ph + uTime * 0.3);
    // Gaussian scaled so density crosses the 1/3 threshold at radius m.
    // The fade scales density, so a cell shrinks below threshold smoothly
    // rather than popping out.
    float d = exp(-(r * r) / (m * m) * ${LN3}) * vFade;
    #ifdef DEPTH_PREPASS
    // Only the solid core occludes: where this blob alone passes threshold.
    if (d < 0.334) discard;
    gl_FragColor = vec4(0.0);
    #else
    if (d < 0.004) discard;
    gl_FragColor = vec4(vColor * d, d);
    #endif
  }
`;

const neuriteVertex = /* glsl */ `
  ${NODE_FETCH_GLSL}
  uniform highp sampler2D uLinks;     // node a, node b
  uniform int uLinksWidth;
  uniform highp sampler2D uNodeGlow; // per node: peak, start time
  uniform float uTime;
  uniform float uGlowHalfLife;
  uniform vec2 uTargetSize;
  uniform float uRadius;
  uniform float uProjScale;
  uniform vec3 uCentre;
  uniform vec3 uViewDir;
  uniform float uDepthSlack;
  varying float vFade;
  varying float vT;
  varying float vAcross;
  varying float vWidthA;
  varying float vWidthB;
  varying vec3 vColor;
  varying float vGlowA;
  varying float vGlowB;

  // Decayed on the GPU like the somas' own glow, so the CPU never touches
  // glow that is merely fading.
  float nodeGlow(float index) {
    vec2 g = texelFetch(uNodeGlow, nodeTexel(index), 0).rg;
    float act = g.x * exp2(-max(0.0, uTime - g.y) / uGlowHalfLife);
    return act < 0.002 ? 0.0 : min(act, 1.0);
  }

  // Two triangles per neurite: (t along, side across).
  const vec2 CORNERS[6] = vec2[6](
    vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
    vec2(0.0, -1.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
  );

  ${NEAR_FADE_GLSL}

  void main() {
    int link = gl_VertexID / 6;
    vec2 corner = CORNERS[gl_VertexID - link * 6];
    vec4 link4 = texelFetch(uLinks, ivec2(link % uLinksWidth, link / uLinksWidth), 0);
    vec2 ends = link4.xy;
    vec3 a = nodePosition(ends.x).xyz;
    vec3 b = nodePosition(ends.y).xyz;
    vFade = nearFade(0.5 * (a + b));
    if (vFade <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec4 va = modelViewMatrix * vec4(a, 1.0);
    vec4 vb = modelViewMatrix * vec4(b, 1.0);
    #ifndef DEPTH_PREPASS
    va.z += uDepthSlack;
    vb.z += uDepthSlack;
    #endif
    if (va.z > -0.05 || vb.z > -0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

    vec4 ca = projectionMatrix * va;
    vec4 cb = projectionMatrix * vb;
    vec2 halfSize = 0.5 * uTargetSize;
    vec2 sa = ca.xy / ca.w * halfSize;
    vec2 sb = cb.xy / cb.w * halfSize;
    vec2 dir = sb - sa;
    float len = length(dir);
    dir = len > 1e-3 ? dir / len : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);

    // Tube radius in pixels where it meets each soma: a third of the cell
    // body, so the body reads as a bulb the neurites grow out of.
    // Never under ~0.6 px, or thin links between small cells drop below the
    // threshold and the cells stop joining up.
    float ra = max(0.32 * uRadius * uProjScale / -va.z, 0.6);
    float rb = max(0.32 * uRadius * uProjScale / -vb.z, 0.6);
    float span = 2.4 * max(ra, rb); // covers the cross-section's tail

    float t = corner.x;
    vec2 s = mix(sa, sb, t) + normal * corner.y * span;
    float w = mix(ca.w, cb.w, t);
    gl_Position = vec4(s / halfSize * w, mix(ca.z / ca.w, cb.z / cb.w, t) * w, w);

    vT = t;
    vAcross = corner.y * span;
    vWidthA = ra;
    vWidthB = rb;
    vColor = mix(nodeTissue(ends.x), nodeTissue(ends.y), t);
    vGlowA = nodeGlow(ends.x);
    vGlowB = nodeGlow(ends.y);
  }
`;

const neuriteFragment = /* glsl */ `
  varying float vGlowA;
  varying float vGlowB;
  varying float vFade;
  varying float vT;
  varying float vAcross;
  varying float vWidthA;
  varying float vWidthB;
  varying vec3 vColor;

  void main() {
    // Thick at both somas, thinning to about 40% midway.
    float ends = mix(vWidthA, vWidthB, vT);
    float w = ends * mix(1.0, 0.5, 4.0 * vT * (1.0 - vT));
    float d = exp(-(vAcross * vAcross) / (w * w) * ${LN3}) * 1.15 * vFade;
    #ifdef DEPTH_PREPASS
    if (d < 0.334) discard;
    gl_FragColor = vec4(0.0);
    return;
    #endif
    if (d < 0.004) discard;
    // A firing soma lights its neurites, fading along them from its end.
    float glow = max(vGlowA * (1.0 - vT) * (1.0 - vT), vGlowB * vT * vT);
    gl_FragColor = vec4(mix(vColor, SIGNAL, glow) * d, d);
  }
`;

const compositeFragment = /* glsl */ `
  uniform sampler2D tDensity;
  uniform float uBody;
  uniform float uRim;
  varying vec2 vUv;

  void main() {
    vec4 d = texture2D(tDensity, vUv);
    float a = d.a;
    // CSS feColorMatrix alpha row "18 -6": 0 at a = 1/3, 1 at a = 7/18.
    float inside = clamp(18.0 * a - 6.0, 0.0, 1.0);
    if (inside <= 0.0) discard;
    // The membrane: brightest just inside the edge, fading toward the core.
    float rim = inside * (1.0 - smoothstep(0.39, 0.85, a));
    vec3 color = d.rgb / max(a, 1e-4);
    gl_FragColor = vec4(color * (uBody * inside + uRim * rim), 0.0);
  }
`;

export interface MembraneOptions {
  /** Soma radius in model units, at the reference camera distance. */
  cellSize?: number;
  /**
   * How far cells follow the zoom: 0 keeps a fixed size in the model (they
   * swell as the camera closes in), 1 keeps a fixed size on screen.
   */
  cellZoom?: number;
  /** Camera distance at which `cellSize` applies as given. */
  referenceDistance?: number;
}

/** Somas and neurites for one network and one neuron layout. */
export class MembraneLayer {
  /** Density pass. */
  readonly scene = new Scene();
  /** Depth pre-pass: the same geometry, opaque cores only. */
  readonly depthScene = new Scene();
  private somaDepthMaterial: ShaderMaterial;
  private neuriteDepthMaterial: ShaderMaterial;
  private depthSlack = { value: 0 };
  private somaGeometry: BufferGeometry;
  private neuriteGeometry: BufferGeometry;
  private somaMaterial: ShaderMaterial;
  private neuriteMaterial: ShaderMaterial;
  private links: DataTexture;
  /** sim.glow as a texture, rows re-uploaded only where something changed. */
  private nodeGlow: DataTexture;
  private nodeGlowData: Float32Array<ArrayBuffer>;
  private glowDirty: DirtySet;
  private dirtyRows: Uint8Array;
  private sim: NetworkSim;
  // Shared by both materials.
  private centre = { value: new Vector3() };
  private viewDir = { value: new Vector3(0, 0, 1) };
  private baseRadius: number;
  private cellZoom: number;
  private referenceDistance: number;

  /**
   * @param nodeGeometry the node layer's geometry, whose position, glow and
   * colour attributes are shared rather than copied.
   */
  constructor(
    sim: NetworkSim,
    layout: NeuronLayout,
    nodeGeometry: BufferGeometry,
    nodes: NodeTextures,
    options: MembraneOptions = {},
  ) {
    this.sim = sim;
    const radius = options.cellSize ?? 0.0018;
    this.baseRadius = radius;
    this.cellZoom = options.cellZoom ?? 1;
    this.referenceDistance = options.referenceDistance ?? 2;
    nodeGeometry.computeBoundingSphere();
    this.centre.value.copy(nodeGeometry.boundingSphere!.center);
    const signal = PALETTE.signal;

    // Somas: an index into the node attributes, drawn as points.
    const somaGeometry = new BufferGeometry();
    for (const name of ['position', 'aGlow', 'aTissue', 'aSeed', 'aDepth']) {
      somaGeometry.setAttribute(name, nodeGeometry.getAttribute(name));
    }
    somaGeometry.setIndex(new BufferAttribute(layout.somas, 1));
    setPulledBounds(somaGeometry, sim.graph.bounds);
    this.somaGeometry = somaGeometry;

    this.depthSlack.value = 2.2 * radius;
    const somaShader = {
      vertexShader: somaVertex.replace(/SIGNAL/g, `vec3(${signal.r.toFixed(4)}, ${signal.g.toFixed(4)}, ${signal.b.toFixed(4)})`),
      fragmentShader: somaFragment,
      // One uniforms object, shared by the density and depth materials.
      uniforms: {
        uTime: { value: 0 },
        uGlowHalfLife: { value: 0.65 },
        uRadius: { value: radius },
        uProjScale: { value: 1 },
        uCentre: this.centre,
        uViewDir: this.viewDir,
        uDepthSlack: this.depthSlack,
      },
    };
    this.somaMaterial = new ShaderMaterial({ ...somaShader, ...densityParams });
    this.somaDepthMaterial = new ShaderMaterial({ ...somaShader, ...depthParams });
    const somas = new Points(somaGeometry, this.somaMaterial);
    const somaCores = new Points(somaGeometry, this.somaDepthMaterial);
    somas.frustumCulled = false;
    somaCores.frustumCulled = false;

    // Glow per node as (peak, start), laid out like the other node textures,
    // so neurites light up from the cell that fired. Only firing changes it;
    // the decay is worked out in the shader.
    const glowRows = Math.max(1, Math.ceil(sim.graph.nodeCount / nodes.width));
    this.nodeGlowData = new Float32Array(nodes.width * glowRows * 2);
    this.nodeGlow = floatTexture(this.nodeGlowData, nodes.width, glowRows, RGFormat);
    this.glowDirty = sim.watchGlow();
    this.dirtyRows = new Uint8Array(glowRows);

    // Neurites: pulled from a texture of (node, node), six vertices each.
    const linkCount = layout.links.length / 2;
    const width = Math.min(DATA_TEXTURE_WIDTH, Math.max(1, linkCount));
    const height = Math.max(1, Math.ceil(linkCount / width));
    const links = new Float32Array(width * height * 4);
    for (let l = 0; l < linkCount; l++) {
      const a = layout.links[l * 2], b = layout.links[l * 2 + 1];
      links[l * 4] = a;
      links[l * 4 + 1] = b;
    }
    this.links = floatTexture(links, width, height);

    const neuriteGeometry = new BufferGeometry();
    neuriteGeometry.setAttribute('position', vertexCountCarrier(linkCount * 6));
    setPulledBounds(neuriteGeometry, sim.graph.bounds);
    this.neuriteGeometry = neuriteGeometry;

    const neuriteShader = {
      vertexShader: neuriteVertex,
      fragmentShader: neuriteFragment.replace(/SIGNAL/g, `vec3(${signal.r.toFixed(4)}, ${signal.g.toFixed(4)}, ${signal.b.toFixed(4)})`),
      uniforms: {
        ...nodes.uniforms(),
        uLinks: { value: this.links },
        uLinksWidth: { value: width },
        uNodeGlow: { value: this.nodeGlow },
        uTime: { value: 0 },
        uGlowHalfLife: { value: 0.65 },
        uTargetSize: { value: new Vector2(1, 1) },
        uRadius: { value: radius },
        uProjScale: { value: 1 },
        uCentre: this.centre,
        uViewDir: this.viewDir,
        uDepthSlack: this.depthSlack,
      },
    };
    this.neuriteMaterial = new ShaderMaterial({ ...neuriteShader, ...densityParams });
    this.neuriteDepthMaterial = new ShaderMaterial({ ...neuriteShader, ...depthParams });
    const neurites = new Mesh(neuriteGeometry, this.neuriteMaterial);
    const neuriteCores = new Mesh(neuriteGeometry, this.neuriteDepthMaterial);
    neurites.frustumCulled = false;
    neuriteCores.frustumCulled = false;

    this.scene.add(neurites, somas);
    this.depthScene.add(neuriteCores, somaCores);
  }

  setCellSize(radius: number, cellZoom = this.cellZoom): void {
    this.baseRadius = radius;
    this.cellZoom = cellZoom;
  }

  /** Cell radius in model units for a camera `distance` from the brain's centre. */
  private radiusAt(distance: number): number {
    const zoom = Math.max(distance, 1e-3) / this.referenceDistance;
    return this.baseRadius * Math.pow(zoom, this.cellZoom);
  }

  /** Typical cell radius on screen, in pixels of a target `height` tall. */
  typicalRadiusPx(camera: PerspectiveCamera, height: number): number {
    const distance = Math.max(0.05, camera.position.distanceTo(this.centre.value));
    const projScale = camera.projectionMatrix.elements[5] * 0.5 * height;
    // 1.2: the mean of the per-cell size spread, 0.9 + 0.6 * seed.
    return (1.2 * this.radiusAt(distance) * projScale) / distance;
  }

  private applyRadius(distance: number): void {
    const radius = this.radiusAt(distance);
    this.somaMaterial.uniforms.uRadius.value = radius;
    this.neuriteMaterial.uniforms.uRadius.value = radius;
    // Blobs this close in depth merge; anything further behind is hidden.
    this.depthSlack.value = 2.2 * radius;
  }

  /** Per-frame uniforms, for a density target `width` x `height` pixels. */
  update(renderer: WebGLRenderer, camera: PerspectiveCamera, width: number, height: number): void {
    // Pixels per model unit at unit distance, for this target.
    const projScale = camera.projectionMatrix.elements[5] * 0.5 * height;
    const s = this.somaMaterial.uniforms;
    s.uTime.value = this.sim.now;
    s.uGlowHalfLife.value = Math.max(0.01, this.sim.params.glow);
    s.uProjScale.value = projScale;
    const n = this.neuriteMaterial.uniforms;
    n.uProjScale.value = projScale;
    n.uTime.value = s.uTime.value;
    n.uGlowHalfLife.value = s.uGlowHalfLife.value;
    this.viewDir.value.copy(camera.position).sub(this.centre.value);
    this.applyRadius(this.viewDir.value.length());
    this.viewDir.value.normalize();

    this.uploadGlow(renderer);
    (n.uTargetSize.value as Vector2).set(width, height);
  }

  /** Copies changed rows of sim.glow into the texture and uploads just those. */
  private uploadGlow(renderer: WebGLRenderer): void {
    const width = this.nodeGlow.image.width;
    const rows = this.dirtyRows;
    const result = this.glowDirty.drain((first, count) => {
      const last = Math.floor((first + count - 1) / width);
      for (let r = Math.floor(first / width); r <= last; r++) rows[r] = 1;
    });
    if (result === 'none') return;
    const src = this.sim.glow;
    const data = this.nodeGlowData;
    if (result === 'all') {
      rows.fill(0);
      data.set(src);
      this.nodeGlow.needsUpdate = true;
      return;
    }

    // Before its first upload, three.js will send the whole array anyway.
    const props = renderer.properties.get(this.nodeGlow) as { __webglTexture?: WebGLTexture; __version?: number };
    const uploaded = props.__webglTexture !== undefined && props.__version === this.nodeGlow.version;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (uploaded) {
      renderer.state.bindTexture(gl.TEXTURE_2D, props.__webglTexture!);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    }
    for (let r = 0; r < rows.length; r++) {
      if (!rows[r]) continue;
      let end = r;
      while (end + 1 < rows.length && rows[end + 1]) end++;
      const from = r * width * 2;
      const to = Math.min(src.length, (end + 1) * width * 2);
      data.set(src.subarray(from, to), from);
      if (uploaded) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, width, end - r + 1, gl.RG, gl.FLOAT, data, from);
      }
      rows.fill(0, r, end + 1);
      r = end;
    }
  }

  dispose(): void {
    this.sim.unwatchGlow(this.glowDirty);
    // The node attributes belong to the node layer: detach before disposing,
    // or three.js frees their GPU buffers along with this geometry.
    for (const name of ['position', 'aGlow', 'aTissue', 'aSeed', 'aDepth']) this.somaGeometry.deleteAttribute(name);
    this.somaGeometry.dispose();
    this.neuriteGeometry.dispose();
    this.somaMaterial.dispose();
    this.neuriteMaterial.dispose();
    this.somaDepthMaterial.dispose();
    this.neuriteDepthMaterial.dispose();
    this.links.dispose();
    this.nodeGlow.dispose();
  }
}

/** Renders the current MembraneLayer's density and adds the cells to the frame. */
export class MembranePass extends Pass {
  layer: MembraneLayer | null = null;
  private camera: PerspectiveCamera;
  private timer: GpuTimer;
  private density: WebGLRenderTarget;
  private quad: FullScreenQuad;
  private clearColor = new Color();
  private fullWidth = 1;
  private fullHeight = 1;
  /** Density resolution as a share of the frame's. */
  private scale = 1;

  constructor(camera: Camera, timer: GpuTimer) {
    super();
    this.camera = camera as PerspectiveCamera;
    this.timer = timer;
    this.needsSwap = false;
    this.density = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
    });
    this.quad = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: {
          tDensity: { value: this.density.texture },
          uBody: { value: 0.32 },
          uRim: { value: 0.95 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: compositeFragment,
        ...additive,
      }),
    );
  }

  setSize(width: number, height: number): void {
    this.fullWidth = Math.max(1, width);
    this.fullHeight = Math.max(1, height);
    this.resizeDensity();
  }

  private resizeDensity(): void {
    this.density.setSize(
      Math.max(1, Math.round(this.fullWidth * this.scale)),
      Math.max(1, Math.round(this.fullHeight * this.scale)),
    );
  }

  /**
   * Density is a smooth field and the threshold is applied after it is
   * upsampled, so edges stay crisp at reduced resolution as long as cells
   * stay a few density pixels across; small ones alias or drop below the
   * threshold. So the resolution is the lowest (down to half, a quarter of
   * the pixels) that keeps a typical cell MIN_CELL_PX in radius, in steps
   * of 1/8 so zooming does not reallocate the target every frame.
   */
  private fitScale(layer: MembraneLayer): void {
    const radius = layer.typicalRadiusPx(this.camera, this.fullHeight);
    const wanted = Math.min(1, Math.max(0.5, MIN_CELL_PX / Math.max(radius, 1e-3)));
    const scale = Math.ceil(wanted * 8) / 8;
    if (scale !== this.scale) {
      this.scale = scale;
      this.resizeDensity();
    }
  }

  /** Pins the density resolution (a share of the frame's); null fits it to the cells. */
  setResolution(scale: number | null): void {
    this.fixedScale = scale !== null;
    if (scale !== null && scale !== this.scale) {
      this.scale = Math.min(1, Math.max(0.25, scale));
      this.resizeDensity();
    }
  }
  private fixedScale = false;

  /** How bright the cells' interiors and membranes are. */
  setBrightness(body: number, rim: number): void {
    const u = (this.quad.material as ShaderMaterial).uniforms;
    u.uBody.value = body;
    u.uRim.value = rim;
  }

  render(renderer: WebGLRenderer, _writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    if (!this.layer) return;
    this.timer.begin('membranes');
    if (!this.fixedScale) this.fitScale(this.layer);
    this.layer.update(renderer, this.camera, this.density.width, this.density.height);

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this.density);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.layer.depthScene, this.camera);
    renderer.render(this.layer.scene, this.camera);

    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.setClearColor(this.clearColor, clearAlpha);
    this.quad.render(renderer);

    renderer.autoClear = autoClear;
    this.timer.end();
  }

  dispose(): void {
    this.density.dispose();
    this.quad.material.dispose();
    this.quad.dispose();
  }
}
