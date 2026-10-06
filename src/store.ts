import { create } from 'zustand';

export const PARTICLE_BASELINE = 100_000;
export const PARTICLE_STRETCH = 200_000;
export const KEYFRAME_INTERVAL_SEC = 2;

export type GardenSettings = {
  dispersion: number;
  particleSize: number;
  flowSpeed: number;
  audioReactivity: number;
  bloomIntensity: number;
  colorShiftSpeed: number;
  particleCount: number;
};

export type LiveUniforms = {
  u_density: number;
  u_colorShift: number;
  u_coherence: number;
  u_time: number;
  u_audioRMS: number;
  u_spectralCentroid: number;
  u_dominantFreq: number;
  u_beat: number;
};

const defaultSettings: GardenSettings = {
  dispersion: 1.5,
  particleSize: 1.5,
  flowSpeed: 1.0,
  audioReactivity: 0.7,
  bloomIntensity: 1.5,
  colorShiftSpeed: 1.0,
  particleCount: PARTICLE_BASELINE,
};

export const useGardenStore = create<{
  settings: GardenSettings;
  micEnabled: boolean;
  isRecording: boolean;
  playbackSessionId: string | null;
  setSettings: (p: Partial<GardenSettings>) => void;
  setMicEnabled: (v: boolean) => void;
  setIsRecording: (v: boolean) => void;
  setPlaybackSessionId: (id: string | null) => void;
}>((set) => ({
  settings: defaultSettings,
  micEnabled: false,
  isRecording: false,
  playbackSessionId: null,
  setSettings: (p) => set((s) => ({ settings: { ...s.settings, ...p } })),
  setMicEnabled: (micEnabled) => set({ micEnabled }),
  setIsRecording: (isRecording) => set({ isRecording }),
  setPlaybackSessionId: (playbackSessionId) => set({ playbackSessionId }),
}));
