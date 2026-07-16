import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";

let normalizePosterSyncPhotos: typeof import("../src/pages/api/admin/poster-sync").normalizePosterSyncPhotos;

before(async () => {
  applyTestEnv();
  ({ normalizePosterSyncPhotos } = await import("../src/pages/api/admin/poster-sync"));
});

test("poster sync accepts hosted poster image urls", () => {
  const photos = normalizePosterSyncPhotos([
    {
      url: "https://blob.vercel-storage.com/poster-1.png",
      filename: "poster-1.png",
    },
  ]);

  assert.deepEqual(photos, [
    {
      url: "https://blob.vercel-storage.com/poster-1.png",
      filename: "poster-1.png",
    },
  ]);
});

test("poster sync still accepts legacy data-url poster images", () => {
  const photos = normalizePosterSyncPhotos([
    {
      dataUrl: "data:image/png;base64,AAAA",
      filename: "poster-1.png",
    },
  ]);

  assert.equal(photos[0]?.dataUrl, "data:image/png;base64,AAAA");
  assert.equal(photos[0]?.filename, "poster-1.png");
});

test("poster sync ignores malformed photo payloads and caps the batch", () => {
  const photos = normalizePosterSyncPhotos([
    { url: "https://example.com/0.png" },
    ...Array.from({ length: 20 }, (_, index) => ({
      url: `https://example.com/${index + 1}.png`,
      filename: `poster-${index + 1}.png`,
    })),
  ]);

  assert.equal(photos.length, 10);
  assert.equal(photos[0]?.filename, "poster-1.png");
  assert.equal(photos[9]?.filename, "poster-10.png");
});
