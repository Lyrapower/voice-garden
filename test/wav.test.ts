import { describe, expect, it } from 'vitest';
import { encodeWavMono } from '../src/wavEncoder';

async function bytes(b: Blob) {
  return new DataView(await b.arrayBuffer());
}
const tag = (v: DataView, o: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => v.getUint8(o + i)));

describe('encodeWavMono', () => {
  it('writes a valid 16-bit mono header', async () => {
    const v = await bytes(encodeWavMono(new Float32Array(100), 48000));
    expect(tag(v, 0)).toBe('RIFF');
    expect(tag(v, 8)).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(1); // channels
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(200);
    expect(v.byteLength).toBe(244);
  });
  it('produces a header-only file for an empty recording', async () => {
    const v = await bytes(encodeWavMono(new Float32Array(0), 44100));
    expect(v.byteLength).toBe(44);
    expect(v.getUint32(40, true)).toBe(0);
  });
  it('clips out-of-range samples instead of wrapping', async () => {
    const v = await bytes(encodeWavMono(Float32Array.from([2, -2, 0.5]), 44100));
    expect(v.getInt16(44, true)).toBe(0x7fff);
    expect(v.getInt16(46, true)).toBe(-0x8000);
    expect(v.getInt16(48, true)).toBe(Math.trunc(0.5 * 0x7fff));
  });
});
