import { describe, expect, it } from 'vitest';
import { interpolateKeyframes } from '../src/keyframes';
import type { ParticleKeyframe } from '../src/MemoryHall';

const kf = (t: number, v: number): ParticleKeyframe => ({
  t,
  uniforms: { u_density: v, u_colorShift: v, u_coherence: v, u_audioRMS: v },
  camera: { x: v, y: v, z: v, tx: 0, ty: 0, tz: 0 },
});

describe('interpolateKeyframes', () => {
  it('returns null for an empty recording', () => {
    expect(interpolateKeyframes([], 1)).toBeNull();
  });
  it('clamps before the first and after the last keyframe', () => {
    const k = [kf(1, 10), kf(3, 30)];
    expect(interpolateKeyframes(k, 0)).toBe(k[0]);
    expect(interpolateKeyframes(k, 99)).toBe(k[1]);
  });
  it('interpolates linearly between neighbours', () => {
    const k = [kf(0, 0), kf(2, 20), kf(4, 0)];
    const mid = interpolateKeyframes(k, 1)!;
    expect(mid.uniforms.u_density).toBeCloseTo(10);
    expect(mid.camera.z).toBeCloseTo(10);
    expect(interpolateKeyframes(k, 3)!.uniforms.u_audioRMS).toBeCloseTo(10);
  });
  it('handles a single keyframe', () => {
    const k = [kf(5, 7)];
    expect(interpolateKeyframes(k, 0)).toBe(k[0]);
    expect(interpolateKeyframes(k, 9)).toBe(k[0]);
  });
});
