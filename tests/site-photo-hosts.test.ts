import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";

let isSitePhotoHost: typeof import("../src/lib/websiteTripSync").isSitePhotoHost;

before(async () => {
  applyTestEnv();
  isSitePhotoHost = (await import("../src/lib/websiteTripSync")).isSitePhotoHost;
});

test("only photos on hosts the website can draw are left as they are", () => {
  assert.equal(isSitePhotoHost("https://res.cloudinary.com/demo/image/upload/v1/a.jpg"), true);
  assert.equal(isSitePhotoHost("https://images.unsplash.com/photo-1"), true);
});

test("every other web photo, and uploaded files, are copied to the site's hosting first", () => {
  for (const photo of [
    "https://upload.wikimedia.org/wikipedia/commons/4/41/a.jpg",
    "https://www.ourchinastory.com/images/a.jpg",
    "https://res.cloudinary.com.evil.example/a.jpg",
    "http://res.cloudinary.com/demo/a.jpg",
    "data:image/jpeg;base64,AAAA",
  ]) assert.equal(isSitePhotoHost(photo), false, photo);
});
