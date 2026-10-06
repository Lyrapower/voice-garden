import { openDB, type IDBPDatabase } from 'idb';
import { encodeWavMono } from './wavEncoder';
import { KEYFRAME_INTERVAL_SEC, useGardenStore } from './store';
import type { LiveUniforms } from './store';

export type SessionMetadata = {
  id: string;
  createdAt: string;
  durationSec: number;
  keyFreqs: { voice: number; ai: number };
  intervalSec: number;
};

export type ParticleKeyframe = {
  t: number;
  uniforms: Pick<LiveUniforms, 'u_density' | 'u_colorShift' | 'u_coherence' | 'u_audioRMS'>;
  camera: { x: number; y: number; z: number; tx: number; ty: number; tz: number };
};

const DB_NAME = 'voice-garden-memory';
const STORE = 'sessions';

type Row = {
  id: string;
  metadata: SessionMetadata;
  audio: Blob;
  keyframes: string;
};

async function openMemoryDb(): Promise<IDBPDatabase<{ [STORE]: { key: string; value: Row } }>> {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    },
  });
}

export class MemoryHall {
  private root: HTMLElement;
  private db: IDBPDatabase<{ [STORE]: { key: string; value: Row } }> | null = null;
  private recording = false;
  private recordStart = 0;
  private keyframes: ParticleKeyframe[] = [];
  private lastKeyframeT = 0;
  private currentId = '';
  private audioCapture: {
    startWavCapture: () => void;
    stopWavCaptureAndConcat: () => { samples: Float32Array; sampleRate: number } | null;
  } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.classList.add('memory-hall-inner');
  }

  async init(): Promise<void> {
    this.db = await openMemoryDb();
    await this.refreshList();
  }

  attachAudioCapture(capture: {
    startWavCapture: () => void;
    stopWavCaptureAndConcat: () => { samples: Float32Array; sampleRate: number } | null;
  }): void {
    this.audioCapture = capture;
  }

  startRecording(): void {
    if (this.recording) return;
    this.recording = true;
    this.recordStart = performance.now();
    this.keyframes = [];
    this.lastKeyframeT = 0;
    this.currentId = `sess_${Math.random().toString(36).slice(2, 12)}`;
    this.audioCapture?.startWavCapture();
    useGardenStore.getState().setIsRecording(true);
  }

  async stopRecording(sampleKeyframe: () => ParticleKeyframe, voiceFreq: number, aiFreq: number): Promise<void> {
    if (!this.recording) return;
    this.recording = false;
    useGardenStore.getState().setIsRecording(false);
    const id = this.currentId;
    const durationSec = (performance.now() - this.recordStart) / 1000;
    this.keyframes.push(sampleKeyframe());
    const wav = this.audioCapture?.stopWavCaptureAndConcat();
    let audioBlob: Blob;
    if (wav && wav.samples.length > 0) {
      audioBlob = encodeWavMono(wav.samples, wav.sampleRate);
    } else {
      audioBlob = new Blob([], { type: 'audio/wav' });
    }
    const metadata: SessionMetadata = {
      id,
      createdAt: new Date().toISOString(),
      durationSec,
      keyFreqs: { voice: voiceFreq, ai: Math.max(1, aiFreq) },
      intervalSec: KEYFRAME_INTERVAL_SEC,
    };
    const row: Row = {
      id,
      metadata,
      audio: audioBlob,
      keyframes: JSON.stringify({
        keyframes: this.keyframes,
        intervalSec: KEYFRAME_INTERVAL_SEC,
        metadata,
      }),
    };
    if (this.db) await this.db.put(STORE, row);
    await this.refreshList();
    void aiFreq;
  }

  tickRecording(tSec: number, sampleKeyframe: () => ParticleKeyframe): void {
    if (!this.recording) return;
    if (this.keyframes.length === 0) {
      this.keyframes.push(sampleKeyframe());
      this.lastKeyframeT = tSec;
      return;
    }
    if (tSec - this.lastKeyframeT >= KEYFRAME_INTERVAL_SEC) {
      this.lastKeyframeT = tSec;
      this.keyframes.push(sampleKeyframe());
    }
  }

  private async refreshList(): Promise<void> {
    if (!this.db) return;
    const all = await this.db.getAll(STORE);
    this.root.innerHTML = '';
    for (const row of all.sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt))) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'memory-card';
      card.dataset.id = row.id;
      const dur = row.metadata.durationSec.toFixed(1);
      card.textContent = `${row.metadata.createdAt.slice(0, 19)} · ${dur}s`;
      card.addEventListener('click', () => {
        void this.playSession(row.id);
      });
      this.root.appendChild(card);
    }
  }

  async playSession(id: string): Promise<void> {
    if (!this.db) return;
    const row = await this.db.get(STORE, id);
    if (!row) return;
    useGardenStore.getState().setPlaybackSessionId(id);
    const parsed = JSON.parse(row.keyframes) as { keyframes: ParticleKeyframe[]; metadata: SessionMetadata };
    window.dispatchEvent(
      new CustomEvent('garden-playback', {
        detail: { keyframes: parsed.keyframes, audio: row.audio, metadata: parsed.metadata },
      }),
    );
  }

  exitPlayback(): void {
    useGardenStore.getState().setPlaybackSessionId(null);
    window.dispatchEvent(new CustomEvent('garden-playback-stop'));
  }
}
