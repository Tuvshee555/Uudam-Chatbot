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
    "https://res.cloudinary.com/demo/image/upload/f_jpg,q_100,c_limit,w_2160,h_4096/v123/uudam-travel-trips/poster.png",
  );
  assert.equal(toMessengerImageUrl(toMessengerImageUrl(url)), toMessengerImageUrl(url));
  assert.equal(
    toMessengerImageUrl("https://example.com/poster.png"),
    "https://example.com/poster.png",
  );
});
