import { describe, expect, it } from 'vitest';
import { loopBounds } from '../src/AudioCapture';

const SR = 44100;
const tone = (n: number) => Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(i * 0.05) + 0.01);

describe('loopBounds', () => {
  it('keeps the whole buffer when there is no padding', () => {
    const b = loopBounds(tone(SR), SR);
    expect(b.start).toBe(0);
    expect(b.end).toBeCloseTo(1, 6);
  });

  it('skips encoder padding at both ends', () => {
    const data = new Float32Array(1105 + SR + 700);
    data.set(tone(SR), 1105);
    const b = loopBounds(data, SR);
    expect(b.start).toBeCloseTo(1105 / SR, 9);
    expect(b.end - b.start).toBeCloseTo(1, 6);
  });

  it('falls back to the whole buffer when it is silent', () => {
    expect(loopBounds(new Float32Array(SR), SR)).toEqual({ start: 0, end: 1 });
  });
});
