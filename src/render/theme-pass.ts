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
 */
import { Color, NoBlending, ShaderMaterial, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

export type Theme = 'dark' | 'light';

/** Default background per theme. */
export const THEME_BACKGROUND: Record<Theme, string> = {
  dark: '#04040a',
  light: '#f3f1ec',
};

const fragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec3 uBackground;  // linear
  uniform bool uLight;
  uniform bool uTransparent;
  uniform float uInk;        // how quickly brightness turns into full ink
  uniform vec3 uDeepInk;     // what white-hot light becomes on paper
  varying vec2 vUv;

  void main() {
    vec3 e = texture2D(tDiffuse, vUv).rgb;
    float peak = max(e.r, max(e.g, e.b));

    if (!uLight) {
      if (uTransparent) {
        // Premultiplied: the light itself, covering as much as it is bright.
        gl_FragColor = vec4(e, clamp(peak, 0.0, 1.0));
      } else {
        gl_FragColor = vec4(uBackground + e, 1.0);
      }
      return;
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
    if (uTransparent) {
      gl_FragColor = vec4(ink * cover, cover);
    } else {
      gl_FragColor = vec4(mix(uBackground, ink, cover), 1.0);
    }
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
