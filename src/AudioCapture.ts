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
  private source: MediaStreamAudioSourceNode | null = null;
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

  startAnalyzing(onFeatures: (f: AudioFeatures) => void): void {
    if (!this.stream) throw new Error('No mic stream');
    this.ctx = new AudioContext();
    this.sampleRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1;
    this.source.connect(this.gain);

    // Pre-attach the AudioWorklet recorder so startWavCapture stays synchronous.
    if (isWorkletSupported()) {
      this.workletRecorder = new WorkletRecorder();
      void this.workletRecorder
        .attach(this.ctx, this.gain)
        .then(() => {
          this.workletReady = true;
        })
        .catch(() => {
          this.workletRecorder = null; // fall back to ScriptProcessor
        });
    }

    this.analyzer = Meyda.createMeydaAnalyzer({
      audioContext: this.ctx,
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
