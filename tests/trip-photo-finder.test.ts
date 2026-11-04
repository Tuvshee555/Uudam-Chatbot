import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

type Page = { title: string; width: number; height: number; mime?: string; license?: string; author?: string };
const commonsReply = (pages: Page[]) => ({
  query: { pages: Object.fromEntries(pages.map((page, index) => [String(index + 1), {
    title: `File:${page.title}.jpg`,
    imageinfo: [{ url: `https://upload.example.test/${index}.jpg`, thumburl: `https://thumb.example.test/a/b/${encodeURIComponent(page.title)}.jpg/1920px-${index}.jpg?utm_source=x`,
      descriptionurl: `https://commons.example.test/wiki/File:${index}.jpg`, width: page.width, height: page.height, mime: page.mime || "image/jpeg",
      extmetadata: { LicenseShortName: { value: page.license ?? "CC BY-SA 4.0" }, Artist: { value: `<a href="x">${page.author ?? "Fixture Author"}</a>` } } }],
  }])) },
});
const fetchFor = (pages: Page[]) => (async () => new Response(JSON.stringify(commonsReply(pages)), { status: 200 })) as unknown as typeof fetch;

test("only large landscape photographs under free commercial licences are kept, largest first, with a credit", async () => {
  const { searchCommonsPhotos } = await import("../src/lib/tripPhotoFinder");
  const photos = await searchCommonsPhotos("Norvel old town", { fetchImpl: fetchFor([
    { title: "Norvel old town square", width: 3000, height: 2000 },
    { title: "Norvel old town at dusk", width: 4000, height: 2600, license: "CC0", author: "Vel Mor" },
    { title: "Norvel city map", width: 3000, height: 2000 },
    { title: "Norvel tower portrait", width: 1800, height: 3200 },
    { title: "Norvel small", width: 900, height: 600 },
    { title: "Norvel festival", width: 3000, height: 2000, license: "CC BY-NC 2.0" },
    { title: "Norvel abandoned hotel", width: 3000, height: 2000 },
    { title: "Norvel plan", width: 3000, height: 2000, mime: "image/svg+xml" },
    { title: "Norvel from the space station iss074e0000788", width: 3000, height: 2000 },
    { title: "Erenhot gate near Norvel", width: 3000, height: 2000 },
    { title: "Hippopotamus at Norvel Zoo", width: 3000, height: 2000 },
  ]) });
  assert.deepEqual(photos.map((photo) => photo.title), ["Norvel old town at dusk", "Norvel old town square"]);
  assert.equal(photos[0].url, "https://thumb.example.test/a/b/Norvel%20old%20town%20at%20dusk.jpg/1920px-1.jpg", "tracking query stripped, 1920px rendition");
  assert.deepEqual([photos[0].license, photos[0].author, photos[0].query], ["CC0", "Vel Mor", "Norvel old town"]);
});

test("candidates from several places are interleaved so one place cannot take every slot", async () => {
  const { collectPhotoCandidates } = await import("../src/lib/tripPhotoFinder");
  const byQuery: Record<string, Page[]> = {
    "Norvel beach": [1, 2, 3].map((n) => ({ title: `Norvel beach ${n}`, width: 3000, height: 2000 })),
    "Lumia bridge": [1, 2, 3].map((n) => ({ title: `Lumia bridge ${n}`, width: 2800, height: 1800 })),
  };
  const searches: string[] = [];
  const fetchImpl = (async (input: string) => {
    const raw = decodeURIComponent(new URL(String(input)).searchParams.get("gsrsearch") || "");
    searches.push(raw);
    const query = raw.replace(" filetype:bitmap", "").replace(' incategory:"Quality images"', "");
    // Reviewer-rated photos exist only for the beach; they must lead its list.
    const pages = raw.includes("Quality images") ? (query === "Norvel beach" ? [{ title: "Norvel beach quality", width: 4000, height: 2600 }] : []) : byQuery[query] || [];
    return new Response(JSON.stringify(commonsReply(pages)), { status: 200 });
  }) as unknown as typeof fetch;
  const photos = await collectPhotoCandidates(Object.keys(byQuery), { perQuery: 2, fetchImpl });
  assert.deepEqual(photos.map((photo) => photo.title), ["Norvel beach quality", "Lumia bridge 1", "Norvel beach 1", "Lumia bridge 2"]);
  assert.ok(searches[0].includes("Quality images") && !searches[1].includes("Quality images"), "quality images are searched first for each phrase");
});

test("the vision model's picks decide the order; without a usable answer no photo is used", async () => {
  const { rankPhotos, commonsRendition } = await import("../src/lib/tripPhotoFinder");
  const photo = (n: number) => ({ url: `https://thumb.example.test/x/1920px-${n}.jpg`, pageUrl: "", title: `Photo ${n}`, width: 3000 - n, height: 2000, license: "CC0", author: "", query: "q" });
  const candidates = [1, 2, 3, 4].map(photo);
  const previews = (async () => new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
  assert.equal(commonsRendition(candidates[0].url, 480), "https://thumb.example.test/x/480px-1.jpg");
  const ranked = await rankPhotos(candidates, { subject: "Norvel", count: 2, fetchImpl: previews,
    ask: (async () => ({ text: JSON.stringify({ picks: [3, 1, 3] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })) as never });
  assert.deepEqual(ranked.map((p) => p.title), ["Photo 3", "Photo 1"]);
  const selective = await rankPhotos(candidates, { subject: "Norvel", count: 3, fetchImpl: previews,
    ask: (async () => ({ text: JSON.stringify({ picks: [2] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })) as never });
  assert.deepEqual(selective.map((p) => p.title), ["Photo 2"], "the model may return fewer than asked; nothing weak is topped up");
  const fallback = await rankPhotos(candidates, { subject: "Norvel", count: 2, fetchImpl: previews, ask: (async () => { throw new Error("model down"); }) as never });
  // Changed 2026-11-04: the old fallback (largest unjudged photos) put a war map on a beach trip.
  assert.deepEqual(fallback, [], "unjudged search results are never used");
  const unreachable = (async () => new Response("<html>400</html>", { status: 400 })) as unknown as typeof fetch;
  assert.deepEqual(await rankPhotos(candidates, { subject: "Norvel", count: 2, fetchImpl: unreachable,
    ask: (async () => { throw new Error("must not be called"); }) as never }), [], "no preview reachable: nothing is used, no model call");
  const rejected = await rankPhotos(candidates.slice(0, 2), { subject: "Norvel", count: 2, fetchImpl: previews,
    ask: (async () => ({ text: JSON.stringify({ picks: [2] }), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })) as never });
  assert.deepEqual(rejected.map((p) => p.title), ["Photo 2"], "even a small pool is judged, so a weak photo can be rejected");
  assert.deepEqual(await rankPhotos([], { subject: "Norvel", count: 2 }), [], "nothing to judge, no model call");
});
