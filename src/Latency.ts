export type LatencyProbe = {
  markAudioFrame: () => void;
  markVisualFrame: () => void;
  tickOverlay: () => void;
};

export function createLatencyOverlay(element: HTMLElement): LatencyProbe {
  let lastAudioT = 0;
  let lastVisualT = 0;
  let frameCount = 0;
  let latencyMs = 0;
  const latencyRing: number[] = [];
  let fps = 0;
  let fpsFrame = 0;
  let fpsLast = performance.now();
  let lastDomWrite = 0;

  return {
    markAudioFrame() {
      lastAudioT = performance.now();
    },
    markVisualFrame() {
      lastVisualT = performance.now();
      frameCount++;
      fpsFrame++;
      const now = performance.now();
      if (now - fpsLast >= 500) {
        fps = (fpsFrame / (now - fpsLast)) * 1000;
        fpsFrame = 0;
        fpsLast = now;
      }
      if (frameCount % 60 === 0 && lastAudioT > 0) {
        const d = Math.max(0, lastVisualT - lastAudioT);
        latencyRing.push(d);
        if (latencyRing.length > 20) latencyRing.shift();
        latencyMs = latencyRing.reduce((a, b) => a + b, 0) / latencyRing.length;
      }
    },
    tickOverlay() {
      // Throttle DOM writes: textContent every frame forces layout work for no visible benefit.
      const now = performance.now();
      if (now - lastDomWrite < 250) return;
      lastDomWrite = now;
      element.textContent = `fps ${fps.toFixed(0)}  audio→visual ~${latencyMs.toFixed(1)} ms`;
    },
  };
}
