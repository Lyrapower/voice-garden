import { describe, expect, it } from 'vitest';
import { Controller } from '../src/Controller';

describe('Controller.coherence', () => {
  it('is 1 when voice and stream share a frequency', () => {
    expect(Controller.coherence(440, 440)).toBe(1);
  });
  it('falls linearly and clamps to 0 at 8 kHz apart', () => {
    expect(Controller.coherence(0, 4000)).toBeCloseTo(0.5);
    expect(Controller.coherence(0, 8000)).toBe(0);
    expect(Controller.coherence(0, 20000)).toBe(0);
  });
  it('is symmetric', () => {
    expect(Controller.coherence(300, 900)).toBe(Controller.coherence(900, 300));
  });
});

describe('Controller.update', () => {
  it('keeps every uniform finite and coherence in [0, 1] with no input at all', () => {
    const c = new Controller();
    for (let i = 0; i < 120; i++) {
      const u = c.update(1 / 60, 1, 0.7);
      for (const v of Object.values(u)) expect(Number.isFinite(v)).toBe(true);
      expect(u.u_coherence).toBeGreaterThanOrEqual(0);
      expect(u.u_coherence).toBeLessThanOrEqual(1);
    }
  });
  it('ignores a non-finite pitch from the analyser', () => {
    const c = new Controller();
    c.setAudioFeatures({ rms: 0.2, spectralCentroid: NaN, dominantFreq: 0, beat: 0 });
    expect(c.getVoiceFreq()).toBe(400);
  });
});
