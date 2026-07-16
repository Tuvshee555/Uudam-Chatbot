import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";

let mergeExtractedTrips: typeof import("../src/lib/poster/extractCore").mergeExtractedTrips;

before(async () => {
  applyTestEnv();
  ({ mergeExtractedTrips } = await import("../src/lib/poster/extractCore"));
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
