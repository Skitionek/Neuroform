/**
 * Puts the rendered light onto the page. Everything before this pass draws
 * light on black: dots, synapses, pulses and cells all blend additively, and
 * bloom spreads the brightest of it. That is the dark theme as it stands, and
 * on a light background it would vanish, so instead of reworking every
 * material, this one pass decides what light means on the chosen ground:
 *
 * - dark: the light is added to the background colour;
 * - light: the light becomes ink on paper. Coverage grows with brightness,
 *   so resting tissue is a pale tint and firing is a dense stroke, and the
 *   ink takes the light's hue, darkened, with the white-hot cores of firing
 *   nodes turning to a deep signal blue rather than to grey;
 * - transparent: the same, written with an alpha channel and no background,
 *   so the piece can sit over any page.
 *
 * It is also the last pass and encodes to sRGB itself, standing in for
 * three's OutputPass (no tone mapping is used): one full-screen pass instead
 * of two, so the theming costs next to nothing.
 */
import { Color, NoBlending, ShaderMaterial, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

export type Theme = 'dark' | 'light';

/** Default background per theme. */
export const THEME_BACKGROUND: Record<Theme, string> = {
  dark: '#04040a',
  light: '#f3f1ec',
};

/**
 * Default resting brain colour per theme (the cortex; the cerebellum and stem
 * follow it). On paper the light becomes ink, so the light theme's is a
 * brighter blue that inks a clearer tint.
 */
export const THEME_BRAIN: Record<Theme, string> = {
  dark: '#3d4a8f',
  light: '#5465c4',
};

const fragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec3 uBackground;  // linear
  uniform bool uLight;
  uniform bool uTransparent;
  uniform float uInk;        // how quickly brightness turns into full ink
  uniform vec3 uDeepInk;     // what white-hot light becomes on paper
  varying vec2 vUv;

  vec3 toSRGB(vec3 c) {
    return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
  }

  vec4 compose(vec3 e);

  void main() {
    vec4 c = compose(texture2D(tDiffuse, vUv).rgb);
    gl_FragColor = vec4(toSRGB(c.rgb), c.a);
  }

  vec4 compose(vec3 e) {
    float peak = max(e.r, max(e.g, e.b));

    if (!uLight) {
      // Transparent: premultiplied, the light itself, covering as much as
      // it is bright.
      return uTransparent ? vec4(e, clamp(peak, 0.0, 1.0)) : vec4(uBackground + e, 1.0);
    }

    float lum = dot(e, vec3(0.2126, 0.7152, 0.0722));
    // A gamma below 1: dim resting tissue still lays down visible ink, as it
    // stays visible against the dark ground, while firing saturates.
    float cover = 1.0 - exp(-pow(lum, 0.55) * uInk);
    // The light's hue at full value, and how close to white it is.
    vec3 hue = e / max(peak, 1e-4);
    float white = min(e.r, min(e.g, e.b)) / max(peak, 1e-4);
    // Denser ink is darker; white-hot light becomes the deep signal ink.
    vec3 ink = mix(hue * mix(0.8, 0.35, cover), uDeepInk, white * white * smoothstep(0.3, 0.9, cover));
    return uTransparent ? vec4(ink * cover, cover) : vec4(mix(uBackground, ink, cover), 1.0);
  }
`;

export class ThemePass extends Pass {
  private quad: FullScreenQuad;
  private material: ShaderMaterial;

  constructor() {
    super();
    this.material = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uBackground: { value: new Color(THEME_BACKGROUND.dark) },
        uLight: { value: false },
        uTransparent: { value: false },
        uInk: { value: 3 },
        uDeepInk: { value: new Color('#0b2f7a') },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** `background` is a CSS colour; it is ignored when transparent. */
  set(theme: Theme, background: string, transparent: boolean): void {
    const u = this.material.uniforms;
    u.uLight.value = theme === 'light';
    u.uTransparent.value = transparent;
    (u.uBackground.value as Color).set(background);
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
