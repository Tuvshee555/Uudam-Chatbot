import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import { agentDeps, ALPHA, BETA, htmlResponse, scriptedChat, TRIPS, trip } from "./helpers/agentFixtures";

applyTestEnv();

/**
 * A pasted link is identity, never words: uudamtravel.mn trip pages by their slug (generated
 * hash, staff-renamed, or the last synced one), short links one redirect deep, poster PDF
 * links by their poster; any other site is a page the agent may read as DATA.
 */

const linkDeps = (overrides: Record<string, unknown> = {}) => ({
  slugToTripId: async () => null,
  shortLinkLocation: async () => null,
  ...overrides,
}) as unknown as Parameters<typeof import("../src/lib/assistantAgent/links").resolveLink>[2];

test("trip pages resolve by the generated hash, the staff-renamed slug, or the last synced slug", async () => {
  const { hashedSlugFor, resolveLink } = await import("../src/lib/assistantAgent/links");
  const hashed = await resolveLink(`https://uudamtravel.mn/mn/trips/${hashedSlugFor("t-beta")}?fbclid=IwAR0x`, TRIPS, linkDeps());
  assert.deepEqual([hashed.kind, hashed.trip_id], ["website_trip", "t-beta"]);
  const renamed = await resolveLink("https://www.uudamtravel.mn/en/trips/alfa-hotyn-aylal/", TRIPS, linkDeps());
  assert.deepEqual([renamed.kind, renamed.trip_id, renamed.slug], ["website_trip", "t-alpha", "alfa-hotyn-aylal"]);
  const bare = await resolveLink("https://uudamtravel.mn/trips/alfa-hotyn-aylal", TRIPS, linkDeps());
  assert.equal(bare.trip_id, "t-alpha");
  const asked: string[] = [];
  const synced = await resolveLink("https://uudamtravel.mn/mn/trips/huuchin-ner", TRIPS, linkDeps({ slugToTripId: async (slug: string) => { asked.push(slug); return "t-beta"; } }));
  assert.deepEqual([synced.trip_id, asked], ["t-beta", ["huuchin-ner"]]);
  const unknown = await resolveLink("https://uudamtravel.mn/mn/trips/baihgui", TRIPS, linkDeps());
  assert.equal(unknown.trip_id, undefined);
  assert.equal(unknown.kind, "website_trip");
});

test("a short link is followed exactly one hop; the website's own pages are never asked as aliases", async () => {
  const { resolveLink } = await import("../src/lib/assistantAgent/links");
  const hops: string[] = [];
  const deps = linkDeps({ shortLinkLocation: async (url: string) => { hops.push(url); return url.endsWith("/alfa") ? "/mn/trips/alfa-hotyn-aylal" : "https://uudamtravel.mn/other-alias"; } });
  const short = await resolveLink("https://uudamtravel.mn/alfa", TRIPS, deps);
  assert.deepEqual([short.kind, short.trip_id, short.target], ["short_link", "t-alpha", "https://uudamtravel.mn/mn/trips/alfa-hotyn-aylal"]);
  const chained = await resolveLink("https://uudamtravel.mn/chain", TRIPS, deps);
  assert.equal(chained.trip_id, undefined);
  assert.deepEqual(hops, ["https://uudamtravel.mn/alfa", "https://uudamtravel.mn/chain"], "a short link that leads to another short link is not followed further");
  hops.length = 0;
  const reserved = await resolveLink("https://uudamtravel.mn/trips", TRIPS, deps);
  assert.equal(reserved.kind, "web");
  assert.deepEqual(hops, []);
});

test("a poster PDF link names its poster's trip; a foreign link names no trip", async () => {
  const { identityLinks, resolveLink, resolveLinksInText } = await import("../src/lib/assistantAgent/links");
  const poster = await resolveLink("https://uudam-chatbot.example.app/api/poster-pdf?id=poster-alpha", TRIPS, linkDeps());
  assert.deepEqual([poster.kind, poster.trip_id], ["poster", "t-alpha"]);
  const own = await resolveLink("https://uudam-chatbot.example.app/api/poster-pdf?id=poster-for-t-beta", TRIPS, linkDeps());
  assert.equal(own.trip_id, "t-beta");
  const links = await resolveLinksInText("https://partner.example/tour/42 болон https://uudamtravel.mn/mn/trips/alfa-hotyn-aylal.", TRIPS, linkDeps());
  assert.deepEqual(links.map((link) => [link.kind, link.trip_id ?? null]), [["web", null], ["website_trip", "t-alpha"]]);
  assert.match(links[0].note, /read_web_page/);
  assert.deepEqual(identityLinks(links).map((link) => link.trip_id), ["t-alpha"], "only our own links identify a trip");
});

test("links are cut out of the words: a '?' in a link is not a question, sentence punctuation is not part of the link", async () => {
  const { urlsInText, withoutUrls, chatbotIdsInText } = await import("../src/lib/assistantAgent/links");
  assert.deepEqual(urlsInText("Энийг уншаарай: https://partner.example/tour?id=7&x=1). Бас https://a.example/b!"), ["https://partner.example/tour?id=7&x=1", "https://a.example/b"]);
  assert.equal(withoutUrls("https://uudamtravel.mn/mn/trips/x?fbclid=1 устга"), "устга");
  const withId = trip({ id: "trip-0b6f2a1c-3d4e-4f50-8a9b-0c1d2e3f4a5b", route_name: "ДЕЛЬТА" });
  assert.deepEqual(chatbotIdsInText("trip-0b6f2a1c-3d4e-4f50-8a9b-0c1d2e3f4a5b-г устга", [...TRIPS, withId]).map((entry) => entry.id), [withId.id]);
});

test("a web page becomes readable text: no scripts or styles, table cells split, entities decoded, JSON-LD kept, 20k cap", async () => {
  const { htmlToText, readWebPage, WEB_PAGE_MAX_CHARS } = await import("../src/lib/assistantAgent/webPage");
  const parsed = htmlToText(`<html><head><title>Тур &amp; аялал</title><meta name="description" content="Шинэ жилийн тур"><style>.x{}</style>
    <script type="application/ld+json">{"@type":"Trip","offers":{"price":"1990000"}}</script><script>alert(1)</script></head>
    <body><ul><li>1-р өдөр</li><li>2-р өдөр</li></ul><table><tr><th>Огноо</th><th>Үнэ</th></tr><tr><td>12/20</td><td>1,990,000&nbsp;₮</td></tr></table></body></html>`);
  assert.equal(parsed.title, "Тур & аялал");
  assert.match(parsed.text, /Тайлбар: Шинэ жилийн тур/);
  assert.match(parsed.text, /• 1-р өдөр/);
  assert.match(parsed.text, /12\/20 \| 1,990,000 ₮/);
  assert.match(parsed.text, /"price":"1990000"/);
  assert.doesNotMatch(parsed.text, /alert|\.x\{\}/);

  const big = await readWebPage("https://partner.example/big", async () => htmlResponse(`<p>${"аялал ".repeat(6_000)}</p>`));
  assert.ok(big.ok && big.truncated && big.text.length === WEB_PAGE_MAX_CHARS + 1);
  const http = await readWebPage("http://partner.example/x", async () => htmlResponse("<p>x</p>"));
  assert.deepEqual(http, { ok: false, url: "http://partner.example/x", error: "Зөвхөн https:// хаягийг уншина." });
  const pdf = await readWebPage("https://partner.example/x.pdf", async () => ({ url: "https://partner.example/x.pdf", status: 200, contentType: "application/pdf", body: Buffer.from("%PDF") }));
  assert.ok(!pdf.ok && /PDF, Word бол файлаар/.test(pdf.error));
  const { SafeFetchError } = await import("../src/lib/safeFetch");
  const blocked = await readWebPage("https://internal.example/", async () => { throw new SafeFetchError("blocked_address"); });
  assert.ok(!blocked.ok && /дотоод сүлжээ/.test(blocked.error), JSON.stringify(blocked));
});

test("get_trip shows the poster's hero and day photos, the website link, the generated slug and visibility", async () => {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const { hashedSlugFor } = await import("../src/lib/assistantAgent/links");
  let detail: Record<string, unknown> = {};
  const script = scriptedChat([
    () => [{ name: "get_trip", args: { trip_id: "t-alpha" } }],
    ({ messages }) => { detail = JSON.parse(String(messages.at(-1)!.content)); return [{ name: "reply", args: { text: "ok" } }]; },
  ]);
  await runAgent({ instruction: "альфа мэдээлэл", trips: TRIPS, deps: agentDeps(script.chat, {
    posterPhotos: async (id) => (id === "poster-alpha" ? { hero: "https://res.cloudinary.com/demo-cloud/image/upload/v1/hero.jpg", days: [{ day: 4, photo: "https://res.cloudinary.com/demo-cloud/image/upload/v1/p4.jpg" }] } : null),
  }) });
  assert.deepEqual(detail.website, { published: true, link: "https://uudamtravel.mn/mn/trips/alfa-hotyn-aylal", slug: "alfa-hotyn-aylal", generated_slug: hashedSlugFor("t-alpha") });
  assert.equal(detail.visible_on_site, true);
  assert.equal(detail.partner, false);
  assert.deepEqual((detail.poster as { hero: string }).hero, "https://res.cloudinary.com/demo-cloud/image/upload/v1/hero.jpg");
  assert.equal((detail.itinerary_days as Array<{ photo: string | null }>)[3].photo, "https://res.cloudinary.com/demo-cloud/image/upload/v1/p4.jpg", "a day with no photo of its own shows the poster's");
  assert.deepEqual(detail.age_rules, ALPHA.extra.age_rules);
  void BETA;
});

test("our trip link pasted without https:// is still identity: the linked trip, never the conversation's", async () => {
  const { hashedSlugFor, resolveLink, urlsInText, withoutUrls } = await import("../src/lib/assistantAgent/links");
  const bare = `uudamtravel.mn/mn/trips/${hashedSlugFor("t-beta")}`;
  assert.deepEqual(urlsInText(`${bare} устга`), [`https://${bare}`]);
  assert.deepEqual(urlsInText(`www.${bare}, устга`), [`https://www.${bare}`]);
  assert.deepEqual(urlsInText(`https://${bare} устга`), [`https://${bare}`], "a full link is read once");
  assert.deepEqual(urlsInText("info@uudamtravel.mn/x eva.uudamtravel.mn/y uudamtravel.mn"), [], "no e-mail, sub-domain or bare host");
  assert.equal(withoutUrls(`${bare} устга`), "устга");
  assert.equal((await resolveLink(bare, TRIPS, linkDeps())).trip_id, "t-beta");

  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const turns = [{ role: "admin" as const, text: `«${ALPHA.route_name}» мэдээлэл` }, { role: "assistant" as const, text: `«${ALPHA.route_name}» — идэвхтэй` }];
  const script = scriptedChat([
    ({ messages }) => {
      assert.match(String(messages[1].content), /→ «БЕТА НУУРЫН АЯЛАЛ» \(trip_id=t-beta\)/, "resolved before the model is asked");
      return [{ name: "propose_changes", args: { reply_text: "", actions: [{ action: "delete", trip_id: "t-alpha", summary: "" }] } }];
    },
  ]);
  const result = await runAgent({ instruction: `${bare} устга`, trips: TRIPS, turns, today: new Date("2098-11-01T04:00:00Z"), deps: agentDeps(script.chat) });
  assert.equal(result.outcome.kind, "note");
  assert.match((result.outcome as { text: string }).text, /таны илгээсэн холбоосын аялал биш/);
  void BETA;
});
