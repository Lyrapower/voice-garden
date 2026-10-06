export type AiStreamSample = { t: number; aiFreq: number; aiAmplitude: number };

const BACKEND_PORT = 8787;
// Derive host from page location so the field works from LAN devices, not just localhost.
const HOST = location.hostname || 'localhost';
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${HOST}:${BACKEND_PORT}/live`;
const TELEMETRY_URL = `${location.protocol === 'https:' ? 'https' : 'http'}://${HOST}:${BACKEND_PORT}/api/telemetry`;

const POLL_MS = 100; // 10Hz HTTP fallback
const WS_RETRY_MS = 5000;

/**
 * Live-data client with a three-tier source priority:
 *   1. WebSocket /live (push, lowest latency) — retried in the background
 *   2. HTTP polling /api/telemetry (works against the current 8787 backend)
 *   3. Synthetic mock (only when the backend is unreachable entirely)
 */
export class SocketClient {
  private ws: WebSocket | null = null;
  private mockTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private latest: AiStreamSample = { t: 0, aiFreq: 220, aiAmplitude: 0.15 };
  private onSample: ((s: AiStreamSample) => void) | null = null;
  private disposed = false;
  private pollInFlight = false;

  connect(onSample: (s: AiStreamSample) => void): void {
    this.onSample = onSample;
    this.startMock(); // instant visual feedback while real sources come up
    this.startPolling();
    this.tryWebSocket();
  }

  private accept(d: Partial<AiStreamSample>): void {
    if (typeof d.t === 'number' && typeof d.aiFreq === 'number' && typeof d.aiAmplitude === 'number') {
      this.latest = { t: d.t, aiFreq: d.aiFreq, aiAmplitude: d.aiAmplitude };
      this.onSample?.(this.latest);
    }
  }

  private tryWebSocket(): void {
    if (this.disposed) return;
    try {
      const ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        this.stopMock();
        this.stopPolling(); // WS push supersedes polling
        this.ws = ws;
      };
      ws.onmessage = (ev) => {
        try {
          this.accept(JSON.parse(String(ev.data)) as Partial<AiStreamSample>);
        } catch {
          /* ignore malformed */
        }
      };
      ws.onerror = () => {
        /* onclose follows; handled there */
      };
      ws.onclose = () => {
        this.ws = null;
        if (this.disposed) return;
        this.startPolling(); // degrade gracefully
        this.scheduleWsRetry();
      };
    } catch {
      this.scheduleWsRetry();
    }
  }

  private scheduleWsRetry(): void {
    if (this.disposed || this.wsRetryTimer) return;
    this.wsRetryTimer = setTimeout(() => {
      this.wsRetryTimer = null;
      this.tryWebSocket();
    }, WS_RETRY_MS);
  }

  private startPolling(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setInterval(() => {
      if (this.pollInFlight || document.hidden) return; // don't pile up requests
      this.pollInFlight = true;
      fetch(TELEMETRY_URL, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: Partial<AiStreamSample>) => {
          this.stopMock(); // backend reachable: real data wins over mock
          this.accept(d);
        })
        .catch(() => {
          if (!this.mockTimer && !this.ws) this.startMock();
        })
        .finally(() => {
          this.pollInFlight = false;
        });
    }, POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startMock(): void {
    if (this.mockTimer) return;
    const t0 = performance.now();
    this.mockTimer = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      const aiFreq = 180 + 90 * Math.sin(t * 0.7) + 40 * Math.sin(t * 2.1);
      const aiAmplitude = 0.12 + 0.08 * Math.sin(t * 1.3) ** 2;
      this.latest = { t, aiFreq, aiAmplitude };
      this.onSample?.(this.latest);
    }, 50);
  }

  private stopMock(): void {
    if (this.mockTimer) {
      clearInterval(this.mockTimer);
      this.mockTimer = null;
    }
  }

  getLatest(): AiStreamSample {
    return this.latest;
  }

  disconnect(): void {
    this.disposed = true;
    this.stopMock();
    this.stopPolling();
    if (this.wsRetryTimer) {
      clearTimeout(this.wsRetryTimer);
      this.wsRetryTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.onSample = null;
  }
}
