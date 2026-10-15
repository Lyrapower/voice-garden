import * as THREE from 'three';

/**
 * A night-sky backdrop behind the field: a starfield with a faint galactic band and dust, soft nebula colour in the
 * field's palette, and the limb of a planet at the bottom of the screen with a thin atmosphere. Everything is computed
 * once per size into a texture (no image files, nothing to license), then drawn each frame as a full-screen quad at
 * the far plane, panned a little as the camera orbits so the sky has some depth.
 */

const bakeVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const bakeFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2 uSize;   // texture size in pixels
uniform float uAspect; // width / height of the baked texture

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 h22(vec2 p) { float n = h21(p); return vec2(n, h21(p + n)); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

// one layer of stars on a grid: at most one star per cell, most of them faint
vec3 stars(vec2 p, float cells, float density, float seed) {
  vec2 g = p * cells;
  vec2 id = floor(g);
  vec3 col = vec3(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = id + vec2(x, y);
    float r = h21(c + seed);
    if (r > density) continue;
    vec2 pos = c + h22(c + seed * 1.7);
    float d = length(g - pos) * (uSize.y / cells);  // distance in pixels
    float b = pow(h21(c + seed * 3.1), 14.0) * 1.1 + 0.025;
    float temp = h21(c + seed * 5.3);
    vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.7), smoothstep(0.55, 1.0, temp));
    col += tint * b * exp(-d * d / (0.35 + 1.2 * b));
  }
  return col;
}

void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);

  // deep sky, a touch lighter towards the horizon of the planet
  vec3 col = mix(vec3(0.025, 0.030, 0.070), vec3(0.040, 0.050, 0.110), smoothstep(1.0, 0.0, vUv.y));

  // galactic band running diagonally, with dark dust lanes
  float band = exp(-pow((p.y - 0.62 + (p.x - 0.5 * uAspect) * 0.28) * 3.2, 2.0));
  float dust = smoothstep(0.42, 0.75, fbm(p * 7.0 + 3.0));
  float glow = fbm(p * 2.5) * band;
  col += vec3(0.110, 0.120, 0.180) * glow * (1.0 - 0.75 * dust);

  // nebula wisps in the field's palette, kept faint so the particles stay in front
  float n1 = fbm(p * 1.6 + vec2(4.0, 1.0));
  float n2 = fbm(p * 2.2 + vec2(-2.0, 7.0));
  col += vec3(0.060, 0.090, 0.220) * smoothstep(0.45, 0.85, n1);
  col += vec3(0.170, 0.040, 0.150) * smoothstep(0.55, 0.9, n2) * (0.4 + band);
  col += vec3(0.020, 0.100, 0.120) * smoothstep(0.6, 0.95, fbm(p * 3.1 + 11.0));

  // stars: three layers, denser along the band
  float bandBoost = 1.0 + 2.5 * band * (1.0 - dust);
  col += stars(p, 160.0, 0.10 * bandBoost, 1.0) * 0.8;
  col += stars(p, 60.0, 0.10, 7.0) * 1.1;
  col += stars(p, 18.0, 0.12, 13.0) * 1.4;

  // a planet below: its limb crosses the bottom of the frame, night side dark, a thin lit crescent on the right
  vec2 c = vec2(0.62 * uAspect, -2.42);
  float R = 2.55;
  float d = length(p - c);
  vec2 nrm = (p - c) / max(d, 1e-4);
  if (d < R) {
    float z = sqrt(max(0.0, 1.0 - (d / R) * (d / R)));
    vec3 n3 = normalize(vec3(nrm * (d / R), z));
    vec3 sun = normalize(vec3(0.85, 0.45, -0.85)); // from behind: only a thin crescent is lit
    float lit = smoothstep(0.0, 0.35, dot(n3, sun));
    float clouds = fbm(p * 9.0 + vec2(0.0, 3.0));
    vec3 surf = mix(vec3(0.010, 0.014, 0.030), vec3(0.040, 0.055, 0.100), clouds);
    surf += vec3(0.22, 0.30, 0.45) * lit * (0.5 + 0.5 * clouds);
    col = surf;
  }
  // atmosphere: a thin bright rim and a soft glow outside the limb, bluer on the lit side
  float edge = d - R;
  float side = smoothstep(-0.6, 0.9, nrm.x);
  vec3 atm = mix(vec3(0.10, 0.20, 0.55), vec3(0.35, 0.65, 1.0), side);
  col += atm * exp(-abs(edge) * 160.0) * (0.25 + 0.55 * side);
  col += atm * exp(-max(edge, 0.0) * 14.0) * 0.22 * step(0.0, edge);

  gl_FragColor = vec4(col, 1.0);
}
`;

const showVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.99999, 1.0); }
`;

const showFrag = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uPan;   // 0..1 across the extra width
uniform float uSpan;  // visible fraction of the baked width
void main() {
  vec2 uv = vec2(uPan * (1.0 - uSpan) + vUv.x * uSpan, vUv.y);
  // the bake is authored as on-screen (sRGB) colour; the composer works in linear light and encodes at the end
  gl_FragColor = vec4(pow(texture2D(uTex, uv).rgb, vec3(2.2)), 1.0);
}
`;

/** Extra width baked on each side, so the sky can pan as the camera orbits. */
const OVERSCAN = 1.35;

export class Backdrop {
  readonly mesh: THREE.Mesh;
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly show: THREE.ShaderMaterial;

  constructor() {
    this.show = new THREE.ShaderMaterial({
      vertexShader: showVert,
      fragmentShader: showFrag,
      uniforms: { uTex: { value: null }, uPan: { value: 0.5 }, uSpan: { value: 1 / OVERSCAN } },
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.show);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  /** Bake the sky for a viewport of w x h CSS pixels. Cheap enough to redo on resize. */
  bake(renderer: THREE.WebGLRenderer, w: number, h: number): void {
    const scale = Math.min(1.5, renderer.getPixelRatio());
    const H = Math.max(256, Math.min(1600, Math.round(h * scale)));
    const W = Math.max(256, Math.min(4096, Math.round(w * scale * OVERSCAN)));
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(W, H, { depthBuffer: false });
    const mat = new THREE.ShaderMaterial({
      vertexShader: bakeVert,
      fragmentShader: bakeFrag,
      uniforms: { uSize: { value: new THREE.Vector2(W, H) }, uAspect: { value: W / H } },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    const scene = new THREE.Scene();
    scene.add(quad);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
    mat.dispose();
    quad.geometry.dispose();
    this.show.uniforms.uTex!.value = this.target.texture;
  }

  /** Pan slowly with the camera's orbit angle (radians): four orbits sweep the sky across and back. Slow enough that
   * the trail pass does not smear the stars into dashes. */
  setOrbit(angle: number): void {
    this.show.uniforms.uPan!.value = 0.5 + 0.5 * Math.sin(angle * 0.25);
  }
}
