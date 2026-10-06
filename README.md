# Voice Garden

A real-time, audio-reactive particle field that runs in the browser. Speak, play music or stay silent, and 50k–200k particles respond to pitch, loudness and rhythm.

- **Rendering:** Three.js `InstancedMesh` on WebGL2 with an Unreal bloom pass.
- **Audio:** Web Audio + [Meyda](https://meyda.js.org/) feature extraction (RMS, spectral centroid, dominant frequency, onset "beat").
- **Sessions:** record a session as mono WAV plus particle keyframes, stored locally in IndexedDB, and play it back with the particles driven from the recording.
- **Controls:** a lil-gui panel for dispersion, particle size, flow speed, audio reactivity, bloom and colour drift.
- **Latency overlay:** shows FPS and audio-to-visual delay so you can check the ≤ 80 ms target on your machine.

## Run it

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173) and press **Mic on**.

## Optional live stream

The field can also follow an external voice stream. If a server is listening on port 8787 it is used, in this order: WebSocket `ws://<host>:8787/live`, then HTTP polling `/api/telemetry`. Each message is one JSON object:

```json
{ "t": 12.3, "aiFreq": 440, "aiAmplitude": 0.2 }
```

With no server, a built-in generator supplies similar samples at 20 Hz, so the page always works on its own.

`coherence = 1 - min(|voiceFreq - aiFreq|, 8000) / 8000`, clamped to `[0, 1]`, is blended with loudness to drive the particle uniforms.

## Build

```bash
npm run build      # type-check and build into dist/
npm run zip        # build and pack dist/ into garden-dist.zip
```

## License

MIT
