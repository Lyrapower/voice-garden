import * as THREE from 'three';
import type { LiveUniforms } from './store';

const vertInstanced = /* glsl */ `
precision highp float;
attribute vec3 particleBase;
attribute float particleSeed;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;
uniform float uTime;
uniform float u_density;
uniform float u_coherence;
uniform float u_audioRMS;
uniform float u_flowSpeed;
uniform float u_particleScale;
uniform float u_dispersion;
uniform float u_colorShift;

attribute vec2 uv;
varying float vAlpha;
varying float vGlow;
varying vec3 vColor;
varying vec2 vUv;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

vec3 curlNoise(vec3 p) {
  // Optimized: original computed 18 snoise calls with duplicated gradients; 6 suffice.
  float e = 0.18;
  float inv2e = 1.0 / (2.0 * e);
  float dx = (snoise(p + vec3(e, 0.0, 0.0)) - snoise(p - vec3(e, 0.0, 0.0))) * inv2e;
  float dy = (snoise(p + vec3(0.0, e, 0.0)) - snoise(p - vec3(0.0, e, 0.0))) * inv2e;
  float dz = (snoise(p + vec3(0.0, 0.0, e)) - snoise(p - vec3(0.0, 0.0, e))) * inv2e;
  return vec3(dy - dz, dz - dx, dx - dy);
}

void main() {
  vec3 base = particleBase * u_dispersion;
  float t = uTime * u_flowSpeed * 0.12;
  vec3 p = base * u_density + vec3(t * 0.3, t * 0.21, t * 0.17);
  vec3 flow = curlNoise(p) * (6.0 + u_audioRMS * 14.0) * mix(0.35, 1.0, u_coherence);
  vec3 displaced = base + flow * u_dispersion;

  vec3 worldPos = displaced;
  vec3 toCam = normalize(uCameraPos - worldPos);
  vec3 upRef = abs(toCam.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 right = normalize(cross(upRef, toCam));
  vec3 up = cross(toCam, right);
  float s = (0.35 + u_particleScale * 0.55) * (0.85 + 0.3 * particleSeed);
  vec3 corner = right * position.x * s + up * position.y * s;
  vec4 mvPosition = modelViewMatrix * vec4(displaced + corner, 1.0);
  vUv = uv;

  gl_Position = projectionMatrix * mvPosition;

  float depth = smoothstep(120.0, 8.0, -mvPosition.z);
  vAlpha = mix(0.12, 0.95, depth) * (0.55 + 0.45 * u_coherence);
  vGlow = 0.25 + u_audioRMS * 0.75 + (1.0 - u_coherence) * 0.15;

  float hue = fract(particleSeed * 0.173 + uTime * 0.02 + u_colorShift * 0.12);
  vec3 c1 = vec3(0.55, 0.62, 0.78);
  vec3 c2 = vec3(0.45, 0.72, 0.76);
  vec3 c3 = vec3(0.58, 0.52, 0.74);
  vec3 mixCol = mix(mix(c1, c2, hue), c3, smoothstep(0.35, 0.85, hue));
  vColor = mix(vec3(0.35), mixCol, 0.55 + 0.35 * depth);
}
`;

const fragInstanced = /* glsl */ `
precision highp float;
varying float vAlpha;
varying float vGlow;
varying vec3 vColor;
varying vec2 vUv;

void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float r = length(q);
  float soft = smoothstep(1.0, 0.2, r);
  float core = smoothstep(0.82, 0.0, r);
  float a = soft * vAlpha;
  vec3 col = vColor * (0.65 + 0.35 * core) + vec3(0.08, 0.1, 0.14) * vGlow * core;
  if (a < 0.015) discard;
  gl_FragColor = vec4(col, a);
}
`;

/** Note: PointsMaterial-style rendering uses gl_PointCoord; we use Points for soft discs at scale. */
const vertPoints = /* glsl */ `
precision highp float;
attribute vec3 particleBase;
attribute float particleSeed;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float u_density;
uniform float u_coherence;
uniform float u_audioRMS;
uniform float u_flowSpeed;
uniform float u_particleScale;
uniform float u_dispersion;
uniform float u_size;
uniform float u_colorShift;

varying float vAlpha;
varying float vGlow;
varying vec3 vColor;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

vec3 curlNoise(vec3 p) {
  // Optimized: original computed 18 snoise calls with duplicated gradients; 6 suffice.
  float e = 0.18;
  float inv2e = 1.0 / (2.0 * e);
  float dx = (snoise(p + vec3(e, 0.0, 0.0)) - snoise(p - vec3(e, 0.0, 0.0))) * inv2e;
  float dy = (snoise(p + vec3(0.0, e, 0.0)) - snoise(p - vec3(0.0, e, 0.0))) * inv2e;
  float dz = (snoise(p + vec3(0.0, 0.0, e)) - snoise(p - vec3(0.0, 0.0, e))) * inv2e;
  return vec3(dy - dz, dz - dx, dx - dy);
}

void main() {
  vec3 base = particleBase * u_dispersion;
  float t = uTime * u_flowSpeed * 0.12;
  vec3 p = base * u_density + vec3(t * 0.3, t * 0.21, t * 0.17);
  vec3 flow = curlNoise(p) * (6.0 + u_audioRMS * 14.0) * mix(0.35, 1.0, u_coherence);
  vec3 displaced = base + flow * u_dispersion;

  vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float depth = smoothstep(120.0, 6.0, -mvPosition.z);
  vAlpha = mix(0.1, 0.92, depth) * (0.5 + 0.5 * u_coherence);
  vGlow = 0.22 + u_audioRMS * 0.8 + (1.0 - u_coherence) * 0.12;
  float hue = fract(particleSeed * 0.173 + uTime * 0.02 + u_colorShift * 0.12);
  vec3 c1 = vec3(0.55, 0.62, 0.78);
  vec3 c2 = vec3(0.45, 0.72, 0.76);
  vec3 c3 = vec3(0.58, 0.52, 0.74);
  vec3 mixCol = mix(mix(c1, c2, hue), c3, smoothstep(0.35, 0.85, hue));
  vColor = mix(vec3(0.32), mixCol, 0.52 + 0.38 * depth);
  float ps = u_size * (0.5 + u_particleScale * 1.2) * (0.9 + 0.2 * particleSeed);
  gl_PointSize = ps * (300.0 / max(1.0, -mvPosition.z));
}
`;

const fragPoints = /* glsl */ `
precision highp float;
varying float vAlpha;
varying float vGlow;
varying vec3 vColor;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  float soft = smoothstep(1.0, 0.15, r);
  float core = smoothstep(0.75, 0.0, r);
  float a = soft * vAlpha;
  vec3 col = vColor * (0.62 + 0.38 * core) + vec3(0.07, 0.09, 0.13) * vGlow * core;
  if (a < 0.02) discard;
  gl_FragColor = vec4(col, a);
}
`;

export type ParticleFieldHandle = {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
  setCount: (n: number) => void;
  dispose: () => void;
};

function fillParticles(count: number): { positions: Float32Array; seeds: Float32Array } {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = 18 + Math.random() * 42;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    seeds[i] = Math.random();
  }
  return { positions, seeds };
}

export function createParticleField(initialCount: number): ParticleFieldHandle {
  const maxCount = 200_000;
  const { positions, seeds } = fillParticles(maxCount);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('particleBase', new THREE.BufferAttribute(positions.slice(), 3));
  geometry.setAttribute('particleSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setDrawRange(0, initialCount);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      u_density: { value: 1 },
      u_colorShift: { value: 0 },
      u_coherence: { value: 1 },
      u_audioRMS: { value: 0 },
      u_flowSpeed: { value: 1 },
      u_particleScale: { value: 1.5 },
      u_dispersion: { value: 1.5 },
      u_size: { value: 2.0 },
    },
    vertexShader: vertPoints,
    fragmentShader: fragPoints,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,
    material,
    setCount(n: number) {
      const capped = Math.min(maxCount, Math.max(1000, Math.floor(n)));
      geometry.setDrawRange(0, capped);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export function applyLiveUniforms(
  material: THREE.ShaderMaterial,
  live: LiveUniforms,
  extras: { flowSpeed: number; particleSize: number; dispersion: number; pointSize: number },
): void {
  material.uniforms.uTime.value = live.u_time;
  material.uniforms.u_density.value = live.u_density;
  material.uniforms.u_colorShift.value = live.u_colorShift;
  material.uniforms.u_coherence.value = live.u_coherence;
  material.uniforms.u_audioRMS.value = live.u_audioRMS;
  material.uniforms.u_flowSpeed.value = extras.flowSpeed;
  material.uniforms.u_particleScale.value = extras.particleSize;
  material.uniforms.u_dispersion.value = extras.dispersion;
  if (material.uniforms.u_size) material.uniforms.u_size.value = extras.pointSize;
}

export function applyInstancedLiveUniforms(
  material: THREE.ShaderMaterial,
  live: LiveUniforms,
  extras: { flowSpeed: number; particleSize: number; dispersion: number },
  cameraWorld: THREE.Vector3,
): void {
  if (material.uniforms.uCameraPos) material.uniforms.uCameraPos.value.copy(cameraWorld);
  material.uniforms.uTime.value = live.u_time;
  material.uniforms.u_density.value = live.u_density;
  material.uniforms.u_colorShift.value = live.u_colorShift;
  material.uniforms.u_coherence.value = live.u_coherence;
  material.uniforms.u_audioRMS.value = live.u_audioRMS;
  material.uniforms.u_flowSpeed.value = extras.flowSpeed;
  material.uniforms.u_particleScale.value = extras.particleSize;
  material.uniforms.u_dispersion.value = extras.dispersion;
}

/** InstancedMesh variant kept for API parity: same curl field, billboard quads (optional swap). */
export function createParticleInstancedField(count: number): {
  mesh: THREE.InstancedMesh;
  material: THREE.ShaderMaterial;
  setCount: (n: number) => void;
  dispose: () => void;
} {
  const maxCount = 200_000;
  const capped = Math.min(maxCount, Math.max(1000, Math.floor(count)));
  const geo = new THREE.PlaneGeometry(1, 1);
  const { positions, seeds } = fillParticles(maxCount);
  geo.setAttribute('particleBase', new THREE.InstancedBufferAttribute(positions, 3));
  geo.setAttribute('particleSeed', new THREE.InstancedBufferAttribute(seeds, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCameraPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      u_density: { value: 1 },
      u_colorShift: { value: 0 },
      u_coherence: { value: 1 },
      u_audioRMS: { value: 0 },
      u_flowSpeed: { value: 1 },
      u_particleScale: { value: 1.5 },
      u_dispersion: { value: 1.5 },
    },
    vertexShader: vertInstanced,
    fragmentShader: fragInstanced,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const mesh = new THREE.InstancedMesh(geo, material, maxCount);
  mesh.frustumCulled = false;
  mesh.count = capped;
  // Shader builds billboards from particleBase; instanceMatrix is unused.
  // Skipping the 200k setMatrixAt loop + upload saves init time and ~12.8MB GPU transfer.
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

  return {
    mesh,
    material,
    setCount(n: number) {
      mesh.count = Math.min(maxCount, Math.max(1000, Math.floor(n)));
    },
    dispose() {
      geo.dispose();
      material.dispose();
    },
  };
}
