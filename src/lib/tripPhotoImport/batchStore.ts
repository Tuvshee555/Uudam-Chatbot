import { randomUUID } from "crypto";
import type { BatchState } from "./types";

const store = new Map<string, BatchState>();

export function createBatch(trips: BatchState["trips"]): string {
  cleanupExpiredBatches();
  const id = randomUUID();
  store.set(id, {
    id,
    createdAt: Date.now(),
    items: [],
    trips,
  });
  return id;
}

export function getBatch(id: string): BatchState | undefined {
  cleanupExpiredBatches();
  return store.get(id);
}

export function setBatchItems(id: string, items: BatchState["items"]): void {
  const batch = store.get(id);
  if (batch) {
    batch.items = items;
  }
}

export function deleteBatch(id: string): void {
  store.delete(id);
}

let lastCleanup = 0;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_TTL_MS = 60 * 60 * 1000;

function cleanupExpiredBatches(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [id, batch] of store.entries()) {
    if (now - batch.createdAt > BATCH_TTL_MS) {
      store.delete(id);
    }
  }
}
