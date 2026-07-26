import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("Messenger Cloudinary image delivery keeps poster-sized readable images", async () => {
  applyTestEnv();
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const { toMessengerImageUrl } = await import("../src/lib/messenger");

  const url = "https://res.cloudinary.com/demo/image/upload/v123/uudam-travel-trips/poster.png";

  assert.equal(
    toMessengerImageUrl(url),
    "https://res.cloudinary.com/demo/image/upload/f_jpg,q_100,c_limit,w_2160,h_8192/v123/uudam-travel-trips/poster.png",
  );
  assert.equal(toMessengerImageUrl(toMessengerImageUrl(url)), toMessengerImageUrl(url));
  assert.equal(
    toMessengerImageUrl("https://example.com/poster.png"),
    "https://example.com/poster.png",
  );
});

test("the delivery transform never downscales a real poster", async () => {
  // `c_limit` scales both axes to fit, so a height cap below a real poster
  // silently narrows it — the exact failure that made poster text unreadable
  // in Messenger. Posters are rendered at 2160 wide and run tall; the tallest
  // single-page poster in the live catalog is ~5160px. Guard both axes so a
  // future "tidy up the cap" edit cannot reintroduce the downscale.
  applyTestEnv();
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const { toMessengerImageUrl } = await import("../src/lib/messenger");

  const sent = toMessengerImageUrl(
    "https://res.cloudinary.com/demo/image/upload/v1/uudam-travel-trips/tall.jpg",
  );
  const width = Number(sent.match(/,w_(\d+)/)?.[1]);
  const height = Number(sent.match(/,h_(\d+)/)?.[1]);

  assert.ok(width >= 2160, `width cap ${width} would narrow a 2160px-wide poster`);
  assert.ok(height >= 5160, `height cap ${height} would shrink a full-page poster`);
  assert.match(sent, /q_100/, "posters must be delivered at full JPEG quality");
  assert.match(sent, /c_limit/, "must only ever shrink, never upscale or crop");
});
