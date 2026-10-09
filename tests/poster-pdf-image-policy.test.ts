import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedPosterPdfImageUrl } from "../src/lib/poster/pdfImagePolicy";
import { posterPdfHeight } from "../src/lib/poster/pdfLayout";

test("poster PDFs allow public HTTPS image hosts", () => {
  assert.equal(isAllowedPosterPdfImageUrl("https://upload.wikimedia.org/example.jpg"), true);
  assert.equal(isAllowedPosterPdfImageUrl("https://dimg04.c-ctrip.com/example.jpg"), true);
});

test("poster PDF height grows with the itinerary and gallery", () => {
  assert.equal(posterPdfHeight(900), 1528);
  assert.equal(posterPdfHeight(5088.2), 5090);
  assert.equal(posterPdfHeight(99_999), 18_000);
});

test("poster PDFs reject local, private, and credential-bearing image URLs", () => {
  for (const url of [
    "http://images.example.com/photo.jpg",
    "https://localhost/photo.jpg",
    "https://127.0.0.1/photo.jpg",
    "https://192.168.1.5/photo.jpg",
    "https://user:password@images.example.com/photo.jpg",
  ]) {
    assert.equal(isAllowedPosterPdfImageUrl(url), false, url);
  }
});
