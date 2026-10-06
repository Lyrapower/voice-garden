import type { AudioFeatures } from './AudioCapture';
import type { AiStreamSample } from './SocketClient';
import type { LiveUniforms } from './store';

const MAX_FREQ = 8000;

export class Controller {
  private voiceFreq = 400;
  private aiSample: AiStreamSample = { t: 0, aiFreq: 220, aiAmplitude: 0.15 };
  private lastFeatures: AudioFeatures = {
    rms: 0,
    spectralCentroid: 0,
    dominantFreq: 0,
    beat: 0,
  };
  private smoothed = {
    rms: 0,
    coherence: 1,
    colorShift: 0,
    density: 1,
  };

  setAiSample(s: AiStreamSample): void {
    this.aiSample = s;
  }

  setAudioFeatures(f: AudioFeatures): void {
    this.lastFeatures = f;
    const vf = f.dominantFreq > 40 ? f.dominantFreq : f.spectralCentroid;
    this.voiceFreq = Number.isFinite(vf) ? vf : 400;
  }

  getVoiceFreq(): number {
    return this.voiceFreq;
  }

  /** coherence = 1 - |voiceFreq - aiFreq| / maxFreq (clamped) */
  static coherence(voiceHz: number, aiHz: number, maxFreq = MAX_FREQ): number {
    const diff = Math.abs(voiceHz - aiHz);
    return Math.max(0, Math.min(1, 1 - diff / maxFreq));
  }

  update(deltaSec: number, colorShiftSpeed: number, audioReactivity: number): LiveUniforms {
    const coh = Controller.coherence(this.voiceFreq, this.aiSample.aiFreq);
    const targetRms = this.lastFeatures.rms * audioReactivity + this.aiSample.aiAmplitude * (1 - audioReactivity * 0.35);
    const tau = 0.12;
    const a = 1 - Math.exp(-deltaSec / tau);
    this.smoothed.rms += (targetRms - this.smoothed.rms) * a;
    this.smoothed.coherence += (coh - this.smoothed.coherence) * a;
    this.smoothed.colorShift += colorShiftSpeed * deltaSec * 0.08;
    const beatPulse = this.lastFeatures.beat > 0.5 ? 0.08 : 0;
    this.smoothed.density = 1 + this.smoothed.rms * 0.35 + beatPulse + this.aiSample.aiAmplitude * 0.2;

    return {
      u_density: this.smoothed.density,
      u_colorShift: this.smoothed.colorShift % 1000,
      u_coherence: this.smoothed.coherence,
      u_time: performance.now() / 1000,
      u_audioRMS: this.smoothed.rms,
      u_spectralCentroid: this.lastFeatures.spectralCentroid,
      u_dominantFreq: this.voiceFreq,
      u_beat: this.lastFeatures.beat,
    };
  }
}
