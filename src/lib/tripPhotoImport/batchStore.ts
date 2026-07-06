import { randomUUID } from "crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BatchState } from "./types";

const store = new Map<string, BatchState>();
const BATCH_DIR = path.join(os.tmpdir(), "uudam-trip-photo-batches");
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_TTL_MS = 60 * 60 * 1000;

let lastCleanup = 0;
let dirReady: Promise<void> | null = null;

type SerializedBatchState = Omit<BatchState, "items"> & {
  items: Array<
    Omit<BatchState["items"][number], "images"> & {
      images: Array<
        Omit<BatchState["items"][number]["images"][number], "buffer"> & {
          bufferBase64: string;
        }
      >;
    }
  >;
};

function batchFilePath(id: string): string {
  return path.join(BATCH_DIR, `${id}.json`);
}

async function ensureBatchDir(): Promise<void> {
  if (!dirReady) {
    dirReady = mkdir(BATCH_DIR, { recursive: true }).then(() => undefined);
  }
  await dirReady;
}

function serializeBatch(batch: BatchState): string {
  const serialized: SerializedBatchState = {
    ...batch,
    items: batch.items.map((item) => ({
      ...item,
      images: item.images.map((image) => ({
        ...image,
        bufferBase64: image.buffer.toString("base64"),
      })),
    })),
  };
  return JSON.stringify(serialized);
}

function deserializeBatch(raw: string): BatchState {
  const parsed = JSON.parse(raw) as SerializedBatchState;
  return {
    ...parsed,
    items: parsed.items.map((item) => ({
      ...item,
      images: item.images.map(({ bufferBase64, ...image }) => ({
        ...image,
        buffer: Buffer.from(bufferBase64, "base64"),
      })),
    })),
  };
}

async function persistBatch(batch: BatchState): Promise<void> {
  await ensureBatchDir();
  await writeFile(batchFilePath(batch.id), serializeBatch(batch), "utf8");
}

async function cleanupExpiredBatches(): Promise<void> {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  await ensureBatchDir();
  const entries = await readdir(BATCH_DIR, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const filePath = path.join(BATCH_DIR, entry.name);
        try {
          const info = await stat(filePath);
          if (now - info.mtimeMs > BATCH_TTL_MS) {
            const id = entry.name.replace(/\.json$/i, "");
            store.delete(id);
            await rm(filePath, { force: true });
          }
        } catch {
          return;
        }
      }),
  );
}

export async function createBatch(trips: BatchState["trips"]): Promise<string> {
  await cleanupExpiredBatches();
  const id = randomUUID();
  const batch: BatchState = {
    id,
    createdAt: Date.now(),
    items: [],
    trips,
  };
  store.set(id, batch);
  await persistBatch(batch);
  return id;
}

export async function getBatch(id: string): Promise<BatchState | undefined> {
  await cleanupExpiredBatches();
  const cached = store.get(id);
  if (cached) return cached;

  try {
    const raw = await readFile(batchFilePath(id), "utf8");
    const batch = deserializeBatch(raw);
    store.set(id, batch);
    return batch;
  } catch {
    return undefined;
  }
}

export async function setBatchItems(
  id: string,
  items: BatchState["items"],
): Promise<void> {
  const batch = await getBatch(id);
  if (!batch) return;
  batch.items = items;
  store.set(id, batch);
  await persistBatch(batch);
}

export async function deleteBatch(id: string): Promise<void> {
  store.delete(id);
  try {
    await rm(batchFilePath(id), { force: true });
  } catch {
    return;
  }
}
