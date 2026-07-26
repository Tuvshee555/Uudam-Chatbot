import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";

let mergeExtractedTrips: typeof import("../src/lib/poster/extractCore").mergeExtractedTrips;
let resolveFile: typeof import("../src/lib/poster/extractCore").resolveFile;

before(async () => {
  applyTestEnv();
  ({ mergeExtractedTrips, resolveFile } = await import("../src/lib/poster/extractCore"));
});

test("poster extraction merges parallel page results without losing later days", () => {
  const merged = mergeExtractedTrips([
    {
      title: "Чунчин газар нислэг хосолсон",
      subtitle: "7 сарын 19",
      duration_days: 9,
      duration_nights: 8,
      departures: [{ date: "7 сарын 19" }],
      price_table: {
        columns: ["Том хүн", "Хүүхэд"],
        rows: [{ dates: "7 сарын 19", cells: ["2,150,000₮", "2,150,000₮"] }],
        note: "",
      },
      days: [
        { day: 1, route: "УБ-Чунчин", summary: "Page one day one" },
        { day: 2, route: "Чунчин", summary: "Page one day two" },
      ],
      includes: ["Зочид буудал"],
      excludes: [],
    },
    {
      title: "",
      subtitle: "",
      duration_days: 0,
      duration_nights: 0,
      departures: [{ date: "7 сарын 26" }],
      price_table: {
        columns: ["Том хүн", "Хүүхэд"],
        rows: [{ dates: "7 сарын 26", cells: ["2,150,000₮", "2,150,000₮"] }],
        note: "",
      },
      days: [
        { day: 3, route: "Чунчин-Хөх хот", summary: "Page two day three" },
        { day: 4, route: "Хөх хот-УБ", summary: "Page two day four" },
      ],
      includes: ["Хөтөч"],
      excludes: ["Хувийн хэрэглээ"],
    },
  ]);

  assert.equal(merged.title, "Чунчин газар нислэг хосолсон");
  assert.deepEqual(merged.departures, [{ date: "7 сарын 19" }, { date: "7 сарын 26" }]);
  assert.equal(merged.days?.length, 4);
  assert.equal(merged.days?.[2]?.route, "Чунчин-Хөх хот");
  assert.deepEqual(merged.includes, ["Зочид буудал", "Хөтөч"]);
  assert.deepEqual(merged.excludes, ["Хувийн хэрэглээ"]);
  assert.equal(merged.price_table?.rows?.length, 2);
});

test("poster extraction renumbers duplicate page-local day numbers in page order", () => {
  const merged = mergeExtractedTrips([
    {
      title: "Split poster",
      days: [{ day: 1, route: "First slice", summary: "A" }],
      includes: [],
      excludes: [],
    },
    {
      title: "Split poster",
      days: [{ day: 1, route: "Second slice", summary: "B" }],
      includes: [],
      excludes: [],
    },
  ]);

  assert.deepEqual(
    merged.days?.map((day) => [day.day, day.route]),
    [
      [1, "First slice"],
      [2, "Second slice"],
    ],
  );
});

test("poster file download refuses blob URLs outside Vercel Blob", async () => {
  // The blobUrl is supplied by the caller, so a leaked admin secret must not
  // turn this route into a fetch proxy for internal addresses.
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "https://evil.example.com/poster.pdf",
    // Suffix confusion: the allowlist must not match on "contains".
    "https://blob.vercel-storage.com.evil.example.com/poster.pdf",
    "file:///etc/passwd",
    "not a url",
  ]) {
    await assert.rejects(
      () => resolveFile({ blobUrl: url }),
      /зөвхөн Vercel Blob|хаяг буруу/,
      `expected ${url} to be refused`,
    );
  }
});

test("poster file download accepts a genuine Vercel Blob host", async () => {
  // Reaches the network and fails there — the point is that it gets past the
  // host check rather than being refused outright.
  await assert.rejects(
    () => resolveFile({ blobUrl: "https://abc123.public.blob.vercel-storage.com/poster.pdf" }),
    (error: Error) => !/зөвхөн Vercel Blob|хаяг буруу/.test(error.message),
  );
});
