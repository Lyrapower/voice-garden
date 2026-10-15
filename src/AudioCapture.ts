import Meyda from 'meyda';
import type { LatencyProbe } from './Latency';
import { WorkletRecorder, isWorkletSupported } from './recorderWorklet';

export type AudioFeatures = {
  rms: number;
  spectralCentroid: number;
  dominantFreq: number;
  beat: number;
};

const BUFFER_SIZE = 2048;

export class AudioCapture {
  private ctx: AudioContext | null = null;
  private source: AudioNode | null = null;
  private track: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private stream: MediaStream | null = null;
  private analyzer: ReturnType<typeof Meyda.createMeydaAnalyzer> | null = null;
  private wavProcessor: ScriptProcessorNode | null = null; // legacy fallback only
  private workletRecorder: WorkletRecorder | null = null;
  private workletReady = false;
  private mute: GainNode | null = null;
  private prevRms = 0;
  private beatHold = 0;
  private sampleRate = 44100;
  private wavAcc: Float32Array[] = [];
  private recordingWav = false;

  constructor(private readonly latency: LatencyProbe) {}

  async requestMic(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  }

  /** Analyse the microphone (after requestMic). */
  startAnalyzing(onFeatures: (f: AudioFeatures) => void): void {
    if (!this.stream) throw new Error('No mic stream');
    this.ctx = new AudioContext();
    this.sampleRate = this.ctx.sampleRate;
    this.attach(this.ctx.createMediaStreamSource(this.stream), onFeatures);
  }

  /**
   * Play an audio file as a seamless loop and analyse it. Call from a tap: the AudioContext is created before the
   * first await, so iOS Safari lets it play. Web Audio loops sample-exactly (an <audio loop> leaves a gap), and
   * loopBounds skips any encoder padding a decoder leaves at either end.
   */
  async startTrack(url: string, onFeatures: (f: AudioFeatures) => void): Promise<void> {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`demo track: HTTP ${res.status}`);
      const buf = await ctx.decodeAudioData(await res.arrayBuffer());
      if (this.ctx !== ctx) return; // stopped while loading
      const { start, end } = loopBounds(buf.getChannelData(0), buf.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.loopStart = start;
      src.loopEnd = end;
      src.connect(ctx.destination);
      this.attach(src, onFeatures);
      src.start(0, start);
      this.track = src;
    } catch (e) {
      if (this.ctx === ctx) this.stop();
      throw e;
    }
  }

  private attach(source: AudioNode, onFeatures: (f: AudioFeatures) => void): void {
    const ctx = this.ctx!;
    this.source = source;
    this.gain = ctx.createGain();
    this.gain.gain.value = 1;
    this.source.connect(this.gain);

    // Pre-attach the AudioWorklet recorder so startWavCapture stays synchronous.
    if (isWorkletSupported()) {
      this.workletRecorder = new WorkletRecorder();
      void this.workletRecorder
        .attach(ctx, this.gain)
        .then(() => {
          this.workletReady = true;
        })
        .catch(() => {
          this.workletRecorder = null; // fall back to ScriptProcessor
        });
    }

    this.analyzer = Meyda.createMeydaAnalyzer({
      audioContext: ctx,
      source: this.gain,
      bufferSize: BUFFER_SIZE,
      featureExtractors: ['rms', 'spectralCentroid', 'amplitudeSpectrum'],
      callback: (features: Record<string, unknown>) => {
        this.latency.markAudioFrame();
        const rms = typeof features.rms === 'number' ? features.rms : 0;
        const sc =
          typeof features.spectralCentroid === 'number' ? features.spectralCentroid : 0;
        const spec = features.amplitudeSpectrum as number[] | undefined;
        let dominantFreq = sc;
        if (spec && spec.length > 4) {
          let peak = 0;
          let peakI = 0;
          for (let i = 1; i < spec.length; i++) {
            const v = spec[i] ?? 0;
            if (v > peak) {
              peak = v;
              peakI = i;
            }
          }
          const nyq = this.sampleRate / 2;
          dominantFreq = (peakI / Math.max(1, spec.length - 1)) * nyq;
        }
        const thr = 0.02 + this.prevRms * 0.08;
        let beat = 0;
        if (this.beatHold > 0) this.beatHold--;
        if (rms > this.prevRms * 1.18 && rms > thr && this.beatHold === 0) {
          beat = 1;
          this.beatHold = 8;
        }
        this.prevRms = rms * 0.92 + this.prevRms * 0.08;
        onFeatures({
          rms: Math.min(1, rms * 4),
          spectralCentroid: sc,
          dominantFreq,
          beat: Math.max(beat, this.beatHold > 6 ? 0.35 : 0),
        });
      },
    });
    this.analyzer.start();
  }

  startWavCapture(): void {
    if (!this.ctx || !this.gain) return;
    if (this.workletRecorder && this.workletReady) {
      this.workletRecorder.start();
      return;
    }
    // Legacy fallback: ScriptProcessorNode (deprecated, main-thread).
    this.wavAcc = [];
    this.recordingWav = true;
    if (this.wavProcessor) return;
    const proc = this.ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => {
      if (!this.recordingWav) return;
      const input = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.wavAcc.push(copy);
    };
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.gain.connect(proc);
    proc.connect(this.mute);
    this.mute.connect(this.ctx.destination);
    this.wavProcessor = proc;
  }

  stopWavCaptureAndConcat(): { samples: Float32Array; sampleRate: number } | null {
    if (this.workletRecorder && this.workletReady && this.ctx) {
      return this.workletRecorder.stopAndConcat(this.ctx.sampleRate);
    }
    this.recordingWav = false;
    if (!this.wavAcc.length || !this.ctx) return null;
    let len = 0;
    for (const c of this.wavAcc) len += c.length;
    const out = new Float32Array(len);
    let o = 0;
    for (const c of this.wavAcc) {
      out.set(c, o);
      o += c.length;
    }
    this.wavAcc = [];
    return { samples: out, sampleRate: this.ctx.sampleRate };
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  getAudioContext(): AudioContext | null {
    return this.ctx;
  }

  async suspend(): Promise<void> {
    await this.ctx?.suspend();
  }

  async resume(): Promise<void> {
    await this.ctx?.resume();
  }

  stop(): void {
    this.recordingWav = false;
    this.wavAcc = [];
    this.workletRecorder?.dispose();
    this.workletRecorder = null;
    this.workletReady = false;
    try {
      this.analyzer?.stop();
    } catch {
      /* ignore */
    }
    this.analyzer = null;
    if (this.wavProcessor && this.gain && this.mute) {
      try {
        this.gain.disconnect(this.wavProcessor);
      } catch {
        /* ignore */
      }
      try {
        this.wavProcessor.disconnect();
      } catch {
        /* ignore */
      }
      try {
        this.mute.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.wavProcessor = null;
    this.mute = null;
    try {
      this.track?.stop();
    } catch {
      /* ignore */
    }
    this.track = null;
    this.source?.disconnect();
    this.source = null;
    this.gain?.disconnect();
    this.gain = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}

/**
 * Loop points in seconds that skip exact digital silence at either end: the encoder padding some decoders keep.
 * The track itself never starts or ends in silence (its reverb tail wraps to the start), so anything below the
 * threshold at the edges is padding. Falls back to the whole buffer if it is silent throughout.
 */
export function loopBounds(data: Float32Array, sampleRate: number, threshold = 1e-5): { start: number; end: number } {
  let a = 0;
  while (a < data.length && Math.abs(data[a]!) < threshold) a++;
  let b = data.length;
  while (b > a && Math.abs(data[b - 1]!) < threshold) b--;
  if (b <= a) return { start: 0, end: data.length / sampleRate };
  return { start: a / sampleRate, end: b / sampleRate };
}
