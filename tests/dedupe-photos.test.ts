import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { applyTestEnv } from "./helpers/env";

async function loadDedupe() {
  applyTestEnv();
  return import("../src/lib/tripPhotoImport/dedupePhotos");
}

/** A deterministic poster-ish image: a coloured gradient with a distinct block. */
async function makeImage(seed: number, format: "png" | "jpeg", size = { w: 120, h: 160 }) {
  const channels = 3;
  const raw = Buffer.alloc(size.w * size.h * channels);
  for (let y = 0; y < size.h; y++) {
    for (let x = 0; x < size.w; x++) {
      const i = (y * size.w + x) * channels;
      raw[i] = (x * 2 + seed * 40) % 256;
      raw[i + 1] = (y * 2 + seed * 25) % 256;
      raw[i + 2] = y > size.h / 2 && seed % 2 === 0 ? 20 : 220;
    }
  }
  const img = sharp(raw, { raw: { width: size.w, height: size.h, channels } });
  return format === "png" ? img.png().toBuffer() : img.jpeg({ quality: 82 }).toBuffer();
}

/** Serves fixed buffers over http so the helper's fetch path is exercised. */
async function withServer(
  bodies: Array<{ buf: Buffer; type: string }>,
  run: (urls: string[]) => Promise<void>,
) {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const idx = Number((req.url || "/0").slice(1));
    const item = bodies[idx];
    if (!item) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", item.type);
    res.end(item.buf);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(bodies.map((_, i) => `http://127.0.0.1:${port}/${i}`));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("byte-identical re-uploads collapse to one photo", async () => {
  const { dedupePhotoUrlsByContent } = await loadDedupe();
  const png = await makeImage(1, "png");
  await withServer(
    [{ buf: png, type: "image/png" }, { buf: png, type: "image/png" }],
    async (urls) => {
      const kept = await dedupePhotoUrlsByContent(urls);
      assert.equal(kept.length, 1, "the same bytes uploaded twice must not be sent twice");
    },
  );
});

test("the same poster re-encoded as JPEG collapses, keeping the smaller file", async () => {
  // Staff re-export a poster and it lands as a second Cloudinary object with
  // different bytes. The customer must not receive the same page twice.
  const { dedupePhotoUrlsByContent } = await loadDedupe();
  const png = await makeImage(2, "png");
  const jpeg = await makeImage(2, "jpeg");
  assert.notEqual(png.length, jpeg.length);
  await withServer(
    [{ buf: png, type: "image/png" }, { buf: jpeg, type: "image/jpeg" }],
    async (urls) => {
      const kept = await dedupePhotoUrlsByContent(urls);
      assert.equal(kept.length, 1);
      assert.equal(kept[0], urls[1], "should keep the smaller JPEG of an identical picture");
    },
  );
});

test("genuinely different poster pages are both kept", async () => {
  const { dedupePhotoUrlsByContent } = await loadDedupe();
  const page1 = await makeImage(3, "png");
  const page2 = await makeImage(8, "png");
  await withServer(
    [{ buf: page1, type: "image/png" }, { buf: page2, type: "image/png" }],
    async (urls) => {
      const kept = await dedupePhotoUrlsByContent(urls);
      assert.equal(kept.length, 2, "different pages must never be treated as duplicates");
    },
  );
});

test("an unreachable image is kept rather than silently dropped", async () => {
  const { dedupePhotoUrlsByContent } = await loadDedupe();
  const png = await makeImage(4, "png");
  await withServer([{ buf: png, type: "image/png" }], async (urls) => {
    const dead = urls[0].replace(/\/0$/, "/99");
    const kept = await dedupePhotoUrlsByContent([urls[0], dead], { timeoutMs: 2000 });
    assert.deepEqual(kept, [urls[0], dead]);
  });
});
