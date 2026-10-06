/**
 * Phase-2 migration target — server storage, NOT File System API
 * Cross-platform compatible (works iOS/Safari): uses fetch only; no File System Access API.
 */

const PHASE2_BASE = '/memory';

export type MemorySavePayload = {
  id: string;
  metadata: Record<string, unknown>;
};

/** Stub: POST /memory/save — FastAPI endpoint (Phase 2). */
export async function postMemorySave(_payload: MemorySavePayload): Promise<Response> {
  return fetch(`${PHASE2_BASE}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(_payload),
  });
}
