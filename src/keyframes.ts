import type { ParticleKeyframe } from './MemoryHall';

/** Linear interpolation between recorded keyframes; clamps to the first / last; null when there are none. */
export function interpolateKeyframes(
  keyframes: ParticleKeyframe[],
  t: number,
): ParticleKeyframe | null {
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (!first || !last) return null;
  if (t <= first.t) return first;
  if (t >= last.t) return last;
  let lo = 0;
  let hi = keyframes.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    const km = keyframes[mid];
    if (!km) break;
    if (km.t <= t) lo = mid;
    else hi = mid;
  }
  const a = keyframes[lo];
  const b = keyframes[hi];
  if (!a || !b) return null;
  const w = (t - a.t) / Math.max(1e-6, b.t - a.t);
  const lerp = (x: number, y: number) => x + (y - x) * w;
  return {
    t,
    uniforms: {
      u_density: lerp(a.uniforms.u_density, b.uniforms.u_density),
      u_colorShift: lerp(a.uniforms.u_colorShift, b.uniforms.u_colorShift),
      u_coherence: lerp(a.uniforms.u_coherence, b.uniforms.u_coherence),
      u_audioRMS: lerp(a.uniforms.u_audioRMS, b.uniforms.u_audioRMS),
    },
    camera: {
      x: lerp(a.camera.x, b.camera.x),
      y: lerp(a.camera.y, b.camera.y),
      z: lerp(a.camera.z, b.camera.z),
      tx: lerp(a.camera.tx, b.camera.tx),
      ty: lerp(a.camera.ty, b.camera.ty),
      tz: lerp(a.camera.tz, b.camera.tz),
    },
  };
}
