/**
 * AudioWorklet-based PCM recorder.
 * Replaces the deprecated ScriptProcessorNode path: capture runs on the
 * audio rendering thread, so main-thread jank (GC, layout, heavy frames)
 * can no longer drop recording samples.
 *
 * The processor source is inlined and loaded via a Blob URL so it works
 * under Vite dev/build and the FastAPI fallback without extra asset wiring.
 */

const PROCESSOR_NAME = 'garden-pcm-recorder';

const PROCESSOR_SOURCE = `
class GardenPcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this.recording = true;
      else if (e.data === 'stop') this.recording = false;
    };
  }
  process(inputs) {
    if (this.recording) {
      const ch = inputs[0] && inputs[0][0];
      if (ch && ch.length) {
        // Copy: the engine reuses this buffer between callbacks.
        const copy = new Float32Array(ch.length);
        copy.set(ch);
        // Transfer ownership — zero-copy handoff to the main thread.
        this.port.postMessage(copy, [copy.buffer]);
      }
    }
    return true; // keep node alive while connected
  }
}
registerProcessor('${PROCESSOR_NAME}', GardenPcmRecorder);
`;

let moduleUrl: string | null = null;
const loadedContexts = new WeakSet<AudioContext>();

async function ensureModule(ctx: AudioContext): Promise<void> {
  if (loadedContexts.has(ctx)) return;
  if (!moduleUrl) {
    moduleUrl = URL.createObjectURL(
      new Blob([PROCESSOR_SOURCE], { type: 'application/javascript' }),
    );
  }
  await ctx.audioWorklet.addModule(moduleUrl);
  loadedContexts.add(ctx);
}

export class WorkletRecorder {
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private active = false;

  /** Build the worklet node and wire it after the given source node. */
  async attach(ctx: AudioContext, source: AudioNode): Promise<void> {
    await ensureModule(ctx);
    this.node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (this.active) this.chunks.push(e.data);
    };
    source.connect(this.node);
    // Worklet output is silent capture-only; route through a muted gain so
    // the graph stays "pulled" by the destination on all browsers (Safari
    // suspends unconnected branches).
    const mute = ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(ctx.destination);
  }

  start(): void {
    this.chunks = [];
    this.active = true;
    this.node?.port.postMessage('start');
  }

  stopAndConcat(sampleRate: number): { samples: Float32Array; sampleRate: number } | null {
    this.active = false;
    this.node?.port.postMessage('stop');
    if (!this.chunks.length) return null;
    let len = 0;
    for (const c of this.chunks) len += c.length;
    const out = new Float32Array(len);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    this.chunks = [];
    return { samples: out, sampleRate };
  }

  dispose(): void {
    this.active = false;
    this.chunks = [];
    if (this.node) {
      this.node.port.postMessage('stop');
      this.node.port.onmessage = null;
      try {
        this.node.disconnect();
      } catch {
        /* ignore */
      }
      this.node = null;
    }
  }
}

export function isWorkletSupported(): boolean {
  return typeof AudioWorkletNode !== 'undefined';
}
