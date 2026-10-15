#!/usr/bin/env python3
"""Writes public/demo-track.mp3: a 16-bar dream-trance loop (138 BPM, A minor), generated entirely from code.

Nothing is sampled or copied, so the result is CC0. The melody and arpeggio are original.
Layers: piano-like arpeggio with ping-pong delay, detuned supersaw pad that ducks on every kick,
rolling off-beat bass, four-on-the-floor kick, off-beat open hat, clap on 2 and 4, and a soft lead
in the second half. Bars 1-4 are a breakdown (piano and pad only, with a noise riser into bar 5),
so the loop breathes. A shared reverb, with its tail wrapped to the start, makes the loop seamless.

Needs numpy, scipy and ffmpeg (only to regenerate the file; the app does not use them):
    python3 scripts/make-demo-track.py
"""
import os
import subprocess
import sys

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
BPM = 138
BEAT = 60 / BPM
BARS = 16
N = int(round(BARS * 4 * BEAT * SR))
rng = np.random.default_rng(7)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def place(buf, sig, t, gain=1.0):
    """Add a mono or stereo signal at time t (seconds), wrapping past the end so the loop is seamless."""
    i = int(round(t * SR)) % N
    if sig.ndim == 1:
        sig = np.stack([sig, sig], 1)
    n = len(sig)
    end = i + n
    if end <= N:
        buf[i:end] += sig * gain
    else:
        k = N - i
        buf[i:] += sig[:k] * gain
        rest = sig[k:]
        while len(rest):
            m = min(len(rest), N)
            buf[:m] += rest[:m] * gain
            rest = rest[m:]


def lp(x, f, order=2):
    return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x, axis=0)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x, axis=0)


# --- harmony: Am | F | C | G, two bars each, twice (16 bars) -------------------------------------
CHORDS = [  # root (MIDI) and chord tones for the pad / arpeggio
    (45, [57, 60, 64, 69]),  # Am
    (41, [57, 60, 65, 69]),  # F (A C F A, close voicing)
    (48, [55, 60, 64, 67]),  # C
    (43, [55, 59, 62, 67]),  # G
]


def chord_at(bar):
    return CHORDS[(bar // 2) % 4]


# --- instruments --------------------------------------------------------------------------------
def piano(f, dur=1.6):
    """Additive piano-like pluck: slightly inharmonic partials, upper partials decay faster."""
    t = np.arange(int(dur * SR)) / SR
    out = np.zeros_like(t)
    for k in range(1, 9):
        fk = f * k * np.sqrt(1 + 0.0004 * k * k)
        if fk > 16000:
            break
        amp = (0.9 ** k) / k ** 0.6
        out += amp * np.sin(2 * np.pi * fk * t + rng.uniform(0, 6.28)) * np.exp(-t * (2.2 + 1.6 * k))
    attack = np.minimum(1, t / 0.004)
    return out * attack * 0.35


def supersaw(freqs, dur, voices=7, detune=0.18):
    t = np.arange(int(dur * SR)) / SR
    L = np.zeros_like(t)
    R = np.zeros_like(t)
    for f in freqs:
        for v in range(voices):
            d = (v - (voices - 1) / 2) / ((voices - 1) / 2)
            fv = hz(f) * 2 ** (d * detune / 12)
            ph = rng.uniform(0, 1)
            saw = 2 * ((t * fv + ph) % 1) - 1
            pan = 0.5 + 0.45 * d
            L += saw * (1 - pan)
            R += saw * pan
    st = np.stack([L, R], 1) / (voices * len(freqs))
    env = np.minimum(1, t / 0.35) * np.minimum(1, (dur - t) / 0.4)
    return lp(st, 2600, 2) * env[:, None]


def kick():
    t = np.arange(int(0.45 * SR)) / SR
    f = 48 + 110 * np.exp(-t * 32)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 7.5)
    click = rng.normal(0, 1, len(t)) * np.exp(-t * 300) * 0.25
    return np.tanh((body + click) * 1.6) * 0.9


def hat(dur=0.16):
    t = np.arange(int(dur * SR)) / SR
    return hp(rng.normal(0, 1, len(t)), 7500, 2) * np.exp(-t * 22) * 0.16


def clap():
    t = np.arange(int(0.3 * SR)) / SR
    n = rng.normal(0, 1, len(t))
    env = sum(np.exp(-np.maximum(0, t - d) * 60) * (t >= d) for d in (0, 0.011, 0.023)) + np.exp(-t * 14) * 0.6
    return sosfilt(butter(2, [900, 4200], 'band', fs=SR, output='sos'), n * env) * 0.22


def bass(f, dur):
    t = np.arange(int(dur * SR)) / SR
    saw = 2 * ((t * hz(f)) % 1) - 1
    sub = np.sin(2 * np.pi * hz(f) * t)
    env = np.minimum(1, t / 0.005) * np.exp(-t * 6)
    return lp(saw * 0.6 + sub * 0.7, 900, 2) * env * 0.42


def lead(f, dur):
    t = np.arange(int(dur * SR)) / SR
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * t) * np.minimum(1, t / 0.4)
    ph = 2 * np.pi * hz(f) * np.cumsum(vib) / SR
    tone = np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.15 * np.sin(3 * ph)
    env = np.minimum(1, t / 0.06) * np.minimum(1, (dur - t) / 0.25)
    return tone * env * 0.14


# --- arrange ------------------------------------------------------------------------------------
drums = np.zeros((N, 2))
music = np.zeros((N, 2))   # goes through the sidechain duck
arp_bus = np.zeros((N, 2))
lead_bus = np.zeros((N, 2))

BREAK = 4  # bars without drums and bass at the top of the loop
kicks = []
ARP = [0, 2, 1, 3, 2, 1, 3, 2]  # index into chord tones, 16th notes, an original rolling figure
for bar in range(BARS):
    root, tones = chord_at(bar)
    t0 = bar * 4 * BEAT
    for beat in range(4):
        tb = t0 + beat * BEAT
        if bar < BREAK:
            continue
        place(drums, kick(), tb)
        kicks.append(tb)
        place(drums, hat(), tb + BEAT / 2)
        if beat in (1, 3):
            place(drums, clap(), tb, 0.9)
        for s in (1, 2, 3):  # rolling bass on the three 16ths after the kick
            place(music, bass(root, BEAT / 4 * 0.9), tb + s * BEAT / 4)
    for s in range(16):
        k = ARP[s % 8]
        note = tones[k] + (12 if (s // 8) % 2 and k == 3 else 0)
        place(arp_bus, piano(hz(note + 12)), t0 + s * BEAT / 4, 0.55 + 0.25 * (s % 4 == 0))
    if bar % 2 == 0:
        place(music, supersaw(tones[:3], 8 * BEAT), t0, 0.5)

# lead melody in bars 9-16: long notes, original
LEAD = [(76, 2), (74, 1), (72, 1), (69, 4),  # Am
        (77, 2), (76, 1), (72, 1), (69, 4),  # F
        (79, 2), (76, 2), (74, 2), (72, 2),  # C
        (74, 3), (71, 1), (67, 4)]           # G
t = 8 * 4 * BEAT
for note, beats in LEAD:
    place(lead_bus, lead(note, beats * BEAT * 0.98), t)
    t += beats * BEAT

# ping-pong delay on the arpeggio (dotted eighth), wrapped
d = int(round(0.75 * BEAT * SR))
echo = np.zeros_like(arp_bus)
src = arp_bus.copy()
for i in range(1, 6):
    src = lp(np.roll(src, d, axis=0), 5000, 1) * 0.42
    echo[:, (i % 2)] += src[:, 0] + src[:, 1] * 0.5
arp_bus = arp_bus + echo * 0.8

# noise riser over the last breakdown bar: high-passed noise swelling into the drop
rl = int(4 * BEAT * SR)
tr = np.arange(rl) / rl
riser = hp(rng.normal(0, 1, (rl, 2)), 2000, 2) * (tr ** 2.2)[:, None] * 0.12
place(drums, riser, (BREAK - 1) * 4 * BEAT)

# sidechain: duck pad, bass, arp and lead on every kick (none in the breakdown)
duck = np.ones(N)
tk = np.arange(int(BEAT * SR)) / SR
shape = 1 - 0.65 * np.exp(-tk / 0.11)
for tb in kicks:
    i = int(round(tb * SR))
    duck[i:i + len(shape)] = np.minimum(duck[i:i + len(shape)], shape[:N - i])
music = (music + arp_bus + lead_bus) * duck[:, None]

# shared reverb: decaying stereo noise impulse, convolved circularly so the tail wraps to the start
rt = int(2.6 * SR)
ti = np.arange(rt) / SR
ir = rng.normal(0, 1, (rt, 2)) * np.exp(-ti * 2.7)[:, None]
ir = lp(hp(ir, 300, 1), 7000, 1)
ir /= np.sqrt((ir ** 2).sum(0))
wet = np.zeros_like(music)
for c in range(2):
    full = fftconvolve(np.concatenate([music[:, c], music[:, c]]), ir[:, c])
    wet[:, c] = full[N:2 * N]  # the second copy carries the tail of the first, so this is a circular convolution
mix = drums + music + wet * 0.32

# master: gentle low cut, soft clip, loudness to about -14 dBFS RMS, peak below -1 dBFS
mix = hp(mix, 30, 2)
mix /= np.sqrt((mix ** 2).mean()) / 10 ** (-14 / 20)
mix = np.tanh(mix * 1.1) / np.tanh(1.1)
peak = np.abs(mix).max()
if peak > 10 ** (-1 / 20):
    mix *= 10 ** (-1 / 20) / peak

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'public', 'demo-track.mp3')
wav = out + '.wav'
pcm = (mix * 32767).astype('<i2')
import wave
with wave.open(wav, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '192k', out], check=True)
os.remove(wav)
print(f'{out}: {N / SR:.2f} s, {BARS} bars at {BPM} BPM, rms {20 * np.log10(np.sqrt((mix ** 2).mean())):.1f} dBFS, '
      f'peak {20 * np.log10(np.abs(mix).max()):.1f} dBFS')
