import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { applyTestEnv } from "./helpers/env";

const originalFetch = globalThis.fetch;

async function loadUploadModule() {
  applyTestEnv({
    CLOUDINARY_CLOUD_NAME: "demo-cloud",
    CLOUDINARY_API_KEY: "demo-key",
    CLOUDINARY_API_SECRET: "demo-secret",
  });
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  return import("../src/lib/tripPhotoImport/upload");
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
});

test("cloudinary batch upload preserves successful url order and reports failures", async () => {
  const { uploadImagesToCloudinary } = await loadUploadModule();
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    if (callCount === 2) {
      return new Response(JSON.stringify({ error: { message: "bad image" } }), {
        status: 400,
      });
    }
    return new Response(
      JSON.stringify({ secure_url: `https://res.cloudinary.com/demo/${callCount}.jpg` }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await uploadImagesToCloudinary([
    { buffer: Buffer.from("one"), fileName: "one.jpg", mimeType: "image/jpeg" },
    { buffer: Buffer.from("two"), fileName: "two.jpg", mimeType: "image/jpeg" },
    { buffer: Buffer.from("three"), fileName: "three.jpg", mimeType: "image/jpeg" },
  ]);

  assert.deepEqual(result.urls, [
    "https://res.cloudinary.com/demo/1.jpg",
    "https://res.cloudinary.com/demo/3.jpg",
  ]);
  assert.deepEqual(result.failures, [{ fileName: "two.jpg", error: "bad image" }]);
});
