/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Corporate catalogue, whole path in one process: snapshot -> render -> draft -> publish -> Messenger.
 *
 * Real code: the snapshot builder, the renderer (when a headless browser exists), the store
 * (versions, publish pointer, send log, attachment cache) and the delivery. Faked: Neon (an
 * in-memory FakeDb behind pg's Pool, the same approach as catalogue-store.test.ts) and Meta (a
 * fetch stub that records every Graph call). Nothing leaves the process.
 *
 * What it pins, for a customer who asks for the catalogue:
 *   - exactly ONE file attachment (attachment.type "file" by attachment_id) and ONE caption text,
 *     the upload first, never an image attachment;
 *   - a webhook redelivery, a repeat ask and a double tap send nothing more; an explicit resend
 *     after the burst window sends again and reuses the Meta attachment id;
 *   - Meta refusing the file -> the caption stays, ONE link text follows, fileAccepted is false;
 *   - a published file whose dated fare changed in the live data is never sent: ONE website-link
 *     text and a staff lead;
 *   - nothing published -> nothing sent, a staff lead.
 * Invented trips only (AGENTS.md).
 */
import assert from "node:assert/strict";
import test, { after, before, mock } from "node:test";
import { applyTestEnv } from "./helpers/env";
import { publicUrlOf } from "./helpers/catalogueSendFakes";
import type { TravelTrip } from "../src/lib/travelTypes";
import type {
  CatalogueDeliveryOutcome,
  CatalogueEdition,
  CatalogueEditionConfig,
  RenderedCatalogue,
  SnapshotInput,
} from "../src/lib/catalogue/types";

// ---------------------------------------------------------------------------------------------
// In-memory Neon: only the statements this flow sends. Untagged statements (the bot's own pause
// and session reads) see an empty database.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, any>;
const ok = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });
const uniqueViolation = (what: string) => Object.assign(new Error(`duplicate key value violates unique constraint "${what}"`), { code: "23505" });

const META_KEYS = [
  "id", "edition", "version_no", "file_name", "status", "size_bytes", "page_count", "sha256", "content_hash",
  "trip_count", "warnings", "public_token", "generated_at", "generated_by", "published_at", "published_by",
];
const metaOf = (row: Row): Row => Object.fromEntries(META_KEYS.map((key) => [key, row[key]]));

class FakeClient {
  undo: Array<() => void> = [];
  inTx = false;
  constructor(private readonly db: FakeDb) {}

  async query(sql: string, params: unknown[] = []) {
    await new Promise((resolve) => setImmediate(resolve));
    const text = sql.trim();
    if (/^BEGIN/i.test(text)) { this.inTx = true; this.undo = []; return ok(); }
    if (/^COMMIT/i.test(text)) { this.finish(); return ok(); }
    if (/^ROLLBACK/i.test(text)) { for (const fn of this.undo.reverse()) fn(); this.finish(); return ok(); }
    if (/pg_advisory_xact_lock/.test(text)) return ok(); // one flow at a time in this test
    const tag = /\/\*\s*cat:(\w+)\s*\*\//.exec(text)?.[1];
    if (!tag) return ok();
    const handler = this.db.handlers[tag];
    if (!handler) throw new Error(`FakeDb has no handler for cat:${tag}`);
    const result = handler(this, params as any[]);
    if (!this.inTx) this.undo = [];
    return result;
  }
  release() { this.finish(); }
  private finish() { this.undo = []; this.inTx = false; }
  insert(table: Row[], row: Row) { table.push(row); this.undo.push(() => { const i = table.indexOf(row); if (i >= 0) table.splice(i, 1); }); }
  update(row: Row, patch: Row) { const before = { ...row }; Object.assign(row, patch); this.undo.push(() => { for (const key of Object.keys(patch)) row[key] = before[key]; }); }
}

class FakeDb {
  versions: Row[] = [];
  pages: Row[] = [];
  sends: Row[] = [];
  fbs: Row[] = [];
  audit: Row[] = [];
  private version(id: unknown) { return this.versions.find((row) => row.id === id); }

  handlers: Record<string, (c: FakeClient, p: any[]) => { rows: Row[]; rowCount: number }> = {
    ddl: () => ok(),
    audit_insert: (c, p) => { c.insert(this.audit, { action: p[0], actor: p[1], edition: p[2], version_id: p[3], detail: JSON.parse(p[4]), at: p[5] }); return ok([], 1); },
    version_next_no: (_c, p) => ok([{ next_no: Math.max(0, ...this.versions.filter((row) => row.edition === p[0]).map((row) => row.version_no)) + 1 }]),
    version_insert: (c, p) => {
      if (this.versions.some((row) => row.public_token === p[12])) throw uniqueViolation("catalogue_versions_public_token_key");
      c.insert(this.versions, {
        id: p[0], edition: p[1], version_no: p[2], file_name: p[3], status: "draft", bytes: p[4], size_bytes: p[5],
        page_count: p[6], sha256: p[7], content_hash: p[8], trip_count: p[9], snapshot: JSON.parse(p[10]),
        warnings: JSON.parse(p[11]), public_token: p[12], generated_at: p[13], generated_by: p[14], published_at: null, published_by: null,
      });
      return ok([], 1);
    },
    page_insert: (c, p) => { c.insert(this.pages, { version_id: p[0], page_no: p[1], jpeg: p[2] }); return ok([], 1); },
    version_meta: (_c, p) => ok(this.version(p[0]) ? [metaOf(this.version(p[0])!)] : []),
    version_pdf: (_c, p) => ok(this.version(p[0]) ? [{ ...metaOf(this.version(p[0])!), bytes: this.version(p[0])!.bytes }] : []),
    version_snapshot: (_c, p) => ok(this.version(p[0]) ? [{ snapshot: this.version(p[0])!.snapshot }] : []),
    published_get: (_c, p) => ok(this.versions.filter((row) => row.edition === p[0] && row.status === "published").slice(0, 1).map(metaOf)),
    version_edition: (_c, p) => ok(this.version(p[0]) ? [{ edition: this.version(p[0])!.edition }] : []),
    version_for_update: (_c, p) => ok(this.version(p[0]) ? [metaOf(this.version(p[0])!)] : []),
    publish_supersede: (c, p) => {
      const rows = this.versions.filter((row) => row.edition === p[0] && row.status === "published" && row.id !== p[1]);
      for (const row of rows) c.update(row, { status: "superseded" });
      return ok(rows.map((row) => ({ id: row.id })));
    },
    publish_activate: (c, p) => {
      const row = this.version(p[0])!;
      if (this.versions.some((other) => other !== row && other.edition === row.edition && other.status === "published")) throw uniqueViolation("catalogue_versions_one_published");
      c.update(row, { status: "published", published_at: p[1], published_by: p[2] });
      return ok([], 1);
    },
    send_suppressed: (c, p) => { const row = this.sends.find((item) => item.id === p[0])!; c.update(row, { suppressed_count: row.suppressed_count + 1 }); return ok([], 1); },
    send_by_dedupe: (_c, p) => ok(this.sends.filter((row) => row.sender_hash === p[0] && row.dedupe_key === p[1]).slice(0, 1).map((row) => ({ id: row.id, status: row.status, created_at: row.created_at }))),
    send_reopen: (c, p) => {
      const row = this.sends.find((item) => item.id === p[0])!;
      c.update(row, { status: "claimed", version_id: p[1], explicit_resend: p[2], created_at: p[3], finished_at: null, meta_message_id: null, reason: null });
      return ok([], 1);
    },
    send_recent: (_c, p) => ok(
      this.sends
        .filter((row) => row.sender_hash === p[0] && row.edition === p[1] && new Date(row.created_at) > new Date(p[2]) && ["claimed", "sent", "sent_link_fallback", "stale_fallback"].includes(row.status))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 10)
        .map((row) => ({ id: row.id, status: row.status, created_at: row.created_at })),
    ),
    send_insert: (c, p) => {
      if (p[5] && this.sends.some((row) => row.sender_hash === p[1] && row.dedupe_key === p[5])) throw uniqueViolation("catalogue_sends_dedupe");
      c.insert(this.sends, { id: p[0], sender_hash: p[1], edition: p[2], version_id: p[3], status: "claimed", meta_message_id: null, reason: null, retries: 0, explicit_resend: p[4], dedupe_key: p[5], suppressed_count: 0, created_at: p[6], finished_at: null });
      return ok([], 1);
    },
    send_finish: (c, p) => {
      const row = this.sends.find((item) => item.id === p[0]);
      if (!row) return ok([], 0);
      c.update(row, { status: p[1], meta_message_id: p[2], reason: p[3], retries: p[4], finished_at: p[5] });
      return ok([], 1);
    },
    fb_get: (_c, p) => ok(this.fbs.filter((row) => row.version_id === p[0] && row.page_id === p[1]).map((row) => ({ attachment_id: row.attachment_id }))),
    fb_put: (c, p) => {
      const existing = this.fbs.find((row) => row.version_id === p[0] && row.page_id === p[1]);
      if (existing) c.update(existing, { attachment_id: p[2], created_at: p[3] });
      else c.insert(this.fbs, { version_id: p[0], page_id: p[1], attachment_id: p[2], created_at: p[3] });
      return ok([], 1);
    },
    fb_clear: (c, p) => { const gone = this.fbs.filter((row) => row.version_id === p[0] && row.page_id === p[1]); for (const row of gone) this.fbs.splice(this.fbs.indexOf(row), 1); return ok([], gone.length); },
  };
}

// ---------------------------------------------------------------------------------------------
// Meta: every Graph call, in order
// ---------------------------------------------------------------------------------------------

type MetaCall =
  | { kind: "upload"; fileName: string; bytes: number; reusable: boolean }
  | { kind: "text"; recipient: string; text: string }
  | { kind: "file"; recipient: string; attachmentType: string; attachmentId: string | null; accepted: boolean }
  | { kind: "other"; body: unknown };

const meta = { calls: [] as MetaCall[], bodies: [] as unknown[], failNextFile: null as { status: number; code: number } | null, serial: 0 };

function metaStub() {
  return async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== "graph.facebook.com") throw new Error(`unexpected network call to ${url.hostname}`);
    if (url.pathname.endsWith("/me/message_attachments")) {
      const form = init?.body as FormData;
      const file = form.get("filedata") as File;
      const declared = JSON.parse(String(form.get("message")));
      meta.calls.push({ kind: "upload", fileName: file.name, bytes: file.size, reusable: declared?.attachment?.payload?.is_reusable === true });
      return new Response(JSON.stringify({ attachment_id: `att-${++meta.serial}` }), { status: 200 });
    }
    if (url.pathname.endsWith("/me/messages")) {
      const body = JSON.parse(String(init?.body || "{}"));
      meta.bodies.push(body);
      const attachment = body?.message?.attachment;
      if (attachment) {
        const failure = meta.failNextFile;
        meta.failNextFile = null;
        meta.calls.push({ kind: "file", recipient: body.recipient?.id, attachmentType: attachment.type, attachmentId: attachment.payload?.attachment_id ?? null, accepted: !failure });
        if (failure) return new Response(JSON.stringify({ error: { message: "scripted refusal", code: failure.code } }), { status: failure.status });
        return new Response(JSON.stringify({ message_id: `m_file_${++meta.serial}`, recipient_id: body.recipient?.id }), { status: 200 });
      }
      if (typeof body?.message?.text === "string") {
        meta.calls.push({ kind: "text", recipient: body.recipient?.id, text: body.message.text });
        return new Response(JSON.stringify({ message_id: `m_text_${++meta.serial}`, recipient_id: body.recipient?.id }), { status: 200 });
      }
      meta.calls.push({ kind: "other", body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected Graph call ${url.pathname}`);
  };
}

// ---------------------------------------------------------------------------------------------
// Invented live data
// ---------------------------------------------------------------------------------------------

const NOW_START = Date.parse("2026-11-06T03:00:00.000Z"); // 11:00 in Ulaanbaatar
const SITE = "https://site.example.test";
const PAGE_ID = "page-e2e";
const PAGE_TOKEN = "test-page-token";
const TITLES = ["Тест-Далай", "Жишиг-Хөдөө", "Загвар-Хот", "Туршилт-Арал", "Хөдөө-Хуурай", "Жишиг-Нуур", "Тест-Уул", "Загвар-Эрэг", "Туршилт-Тал"];

function priceRow(date: string, adult: number) {
  return {
    label: date, dates: [date], display_dates: [date], date_keys: [date], adult_price: adult, adult_price_range: null,
    child_price: null, infant_price: null, child_age: "", infant_age: "", passenger_prices: [], note: "",
  };
}

function liveTrip(n: number, title: string): TravelTrip {
  const first = `2027-0${(n % 3) + 1}-0${(n % 7) + 1}`;
  const fare = 1_200_000 + n * 150_000;
  return {
    id: `e2e-trip-${n}`, category: n % 2 ? "газрын аялал" : "шууд нислэгтэй аялал", operator_name: "", route_name: title,
    duration_text: `${4 + (n % 5)} өдөр ${3 + (n % 5)} шөнө`, adult_price: null, child_price: null, infant_price: null, currency: "MNT",
    departure_dates: [first], seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "",
    source_description: "Жишиг-Эргийн зочид буудалд байрлана. Тест-Парк болон орон нутгийн зах дээр зочилно.",
    photo_urls: [`https://photos.example.test/ok/${n}.jpg`],
    created_at: `2026-01-0${n}T00:00:00.000Z`, updated_at: `2026-01-0${n}T00:00:00.000Z`,
    extra: { price_groups: [priceRow(first, fare)] },
  };
}

const emptyConfig = (over: Partial<CatalogueEditionConfig> = {}): CatalogueEditionConfig =>
  ({ tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [], ...over });

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

let db = new FakeDb();
let nowMs = NOW_START;
let uuidCounter = 0;
let tokenCounter = 0;
let liveTrips: TravelTrip[] = [];
let STORE: typeof import("../src/lib/catalogue/store");
let SCHEMA: typeof import("../src/lib/catalogue/schema");
let SEND: typeof import("../src/lib/catalogue/send");
let FRESH: typeof import("../src/lib/catalogue/freshness");
let DATA: typeof import("../src/lib/catalogue/tripData");
let RENDER: typeof import("../src/lib/catalogue/render");
let FIXTURE: typeof import("../src/lib/catalogue/render/fixture");
let MESSAGES: typeof import("../src/lib/catalogue/messages");

before(async () => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/catalogue-e2e" });
  const { resetEnvCacheForTests } = await import("../src/lib/env");
  resetEnvCacheForTests();
  const { Pool } = await import("pg");
  mock.method(Pool.prototype, "query", (async (sql: string, params?: unknown[]) => new FakeClient(db).query(sql, params ?? [])) as any);
  mock.method(Pool.prototype, "connect", (async () => new FakeClient(db)) as any);
  mock.method(globalThis, "fetch", metaStub() as any);
  STORE = await import("../src/lib/catalogue/store");
  SCHEMA = await import("../src/lib/catalogue/schema");
  SEND = await import("../src/lib/catalogue/send");
  FRESH = await import("../src/lib/catalogue/freshness");
  DATA = await import("../src/lib/catalogue/tripData");
  RENDER = await import("../src/lib/catalogue/render");
  FIXTURE = await import("../src/lib/catalogue/render/fixture");
  MESSAGES = await import("../src/lib/catalogue/messages");
});

after(async () => {
  mock.restoreAll();
  SCHEMA?.setCatalogueRuntimeForTests(null);
  SEND?.setSendDepsForTests(null);
  const { closeNeonPool } = await import("../src/lib/neonDb");
  await closeNeonPool();
});

function resetWorld() {
  db = new FakeDb();
  nowMs = NOW_START;
  uuidCounter = 0;
  tokenCounter = 0;
  meta.calls = [];
  meta.bodies = [];
  meta.failNextFile = null;
  meta.serial = 0;
  liveTrips = TITLES.map((title, index) => liveTrip(index + 1, title));
  SCHEMA.resetCatalogueSchemaForTests();
  SCHEMA.setCatalogueRuntimeForTests({
    now: () => new Date(nowMs),
    uuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    token: () => `E2E${String(++tokenCounter).padStart(29, "0")}`,
  });
  FRESH.resetFreshnessCacheForTests();
}

const advance = (ms: number) => { nowMs += ms; };

function snapshotInput(edition: CatalogueEdition, nowIso: string, trips: TravelTrip[]): SnapshotInput {
  const codeMap = Object.fromEntries(liveTrips.map((trip, index) => [trip.id, `A${String(index + 1).padStart(2, "0")}`]));
  return {
    edition, nowIso, trips, posterByTripId: {}, config: emptyConfig({ tripIds: liveTrips.map((trip) => trip.id) }),
    codeMap, contactPhones: ["7700 0001", "9900 0002"], siteBaseUrl: SITE,
  };
}

/** The live comparison the real wiring makes (stored snapshot vs trips read now), over the fake live trips. */
function driftDeps() {
  return {
    getVersionSnapshot: (versionId: string) => STORE.getVersionSnapshot(versionId),
    loadLiveSnapshot: async (edition: CatalogueEdition, tripIds: string[], nowIso: string) =>
      DATA.buildCatalogueSnapshot(snapshotInput(edition, nowIso, liveTrips.filter((trip) => tripIds.includes(trip.id)))),
    liveDrift: DATA.liveDrift,
  };
}

const standInPdf = (): RenderedCatalogue => ({
  pdf: Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4096, 7), Buffer.from("\n%%EOF")]),
  pageCount: 12, pageImages: [], pageSize: { width: 540, height: 960 }, fonts: ["Noto Sans"], renderMs: 1, warnings: [],
});

type Lead = { status: string; reason: string; context: string };

function deliver(senderId: string, mid: string, over: Partial<Parameters<typeof SEND.deliverCatalogue>[0]> = {}, leads: Lead[] = []): Promise<CatalogueDeliveryOutcome> {
  return SEND.deliverCatalogue({
    senderId, pageId: PAGE_ID, pageToken: PAGE_TOKEN, edition: "quick", explicitResend: false,
    lastInboundAt: nowMs - 60_000, dedupeKey: mid, customerText: "каталог явуулаач",
    captureLead: async (lead) => { leads.push(lead); },
    deps: {
      now: () => new Date(nowMs),
      gate: async () => null,
      killSwitch: () => false,
      checkDrift: (published, nowIso) => FRESH.checkLiveDrift(published, nowIso, driftDeps(), () => nowMs),
      recordFile: async () => {},
      recordOutbound: async () => {},
      assertMaySend: async () => {},
      publicFileUrl: publicUrlOf,
      websiteUrl: () => SITE,
    },
    ...over,
  });
}

const sentTo = (recipient: string) => meta.calls.filter((call) => "recipient" in call && call.recipient === recipient);
const texts = (recipient: string) => sentTo(recipient).filter((call): call is Extract<MetaCall, { kind: "text" }> => call.kind === "text");
const files = (recipient: string) => sentTo(recipient).filter((call): call is Extract<MetaCall, { kind: "file" }> => call.kind === "file");
const uploads = () => meta.calls.filter((call): call is Extract<MetaCall, { kind: "upload" }> => call.kind === "upload");

// ---------------------------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------------------------

async function runFlow(rendered: RenderedCatalogue) {
  resetWorld();
  const caption = MESSAGES.catalogueCaption("quick");

  // 1. Live trips -> snapshot. Nine invented trips, a phone, no blocking warning.
  const snapshot = DATA.buildCatalogueSnapshot(snapshotInput("quick", new Date(nowMs).toISOString(), liveTrips));
  assert.equal(snapshot.trips.length, 9);
  assert.deepEqual(snapshot.trips.map((card) => card.code), ["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A09"]);
  assert.deepEqual(snapshot.warnings.filter((warning) => warning.severity === "blocking"), []);
  assert.ok(snapshot.trips.every((card) => card.price.kind === "from"), "every card carries a dated fare");

  // 2. Draft, and nothing is deliverable yet.
  const draft = await STORE.saveDraftVersion({ edition: "quick", snapshot, rendered, actor: "staff@example.test" });
  assert.equal(draft.status, "draft");
  assert.equal(draft.pageCount, rendered.pageCount);
  assert.equal(draft.sizeBytes, rendered.pdf.length);
  assert.equal(await STORE.getPublished("quick"), null);

  const earlyLeads: Lead[] = [];
  const early = await deliver("cust-early", "mid-early", {}, earlyLeads);
  assert.equal(early.status, "no_published_version");
  assert.equal(early.fileAccepted, false);
  // Owner, launch 2026-11-07: never unanswered. A draft is never sent as a file; the customer gets the safe website text.
  assert.equal(meta.calls.filter((call) => call.kind !== "text").length, 0, "no file, no upload: a draft is never sent");
  assert.deepEqual(texts("cust-early").map((call) => call.text), [MESSAGES.catalogueStaleText(SITE)], "the safe website text, once");
  assert.equal(earlyLeads.length, 1, "staff see that a catalogue was asked for and nothing was published");

  // 3. Publish. The public token addresses the stored bytes.
  const published = await STORE.publishVersion(draft.id, "boss@example.test");
  assert.equal(published.status, "published");
  assert.equal((await STORE.getPublished("quick"))?.id, draft.id);
  assert.ok((await STORE.getVersionPdf(draft.id))?.bytes.equals(rendered.pdf));

  // 4. First ask: caption + ONE file, the upload first.
  const leads: Lead[] = [];
  const first = await deliver("cust-1", "mid-1", {}, leads);
  assert.equal(first.status, "sent");
  assert.equal(first.fileAccepted, true);
  assert.match(String(first.metaMessageId), /^m_file_/);
  assert.deepEqual(leads, [], "a clean send needs no staff lead");
  // (the earlier unpublished request, cust-early, got its own safe text before this send)
  const firstSend = meta.calls.slice(1).map((call) => call.kind); // call 0 is that early safe text
  assert.deepEqual(firstSend, ["upload", "text", "file"], "upload, then the caption, then the file");
  assert.deepEqual(uploads()[0], { kind: "upload", fileName: draft.fileName, bytes: rendered.pdf.length, reusable: true });
  assert.deepEqual(texts("cust-1").map((call) => call.text), [caption]);
  // The id is whatever the single upload returned (the early unpublished text is call 0, so it is not "att-1").
  const uploadedId = String(uploads()[0] ? files("cust-1")[0]?.attachmentId : "");
  assert.match(uploadedId, /^att-\d+$/);
  assert.deepEqual(files("cust-1"), [{ kind: "file", recipient: "cust-1", attachmentType: "file", attachmentId: uploadedId, accepted: true }]);
  assert.ok(!JSON.stringify(meta.bodies).includes('"type":"image"'), "no image attachment, ever");
  assert.ok(!JSON.stringify(meta.bodies).includes('"template"'), "no carousel, no template");

  // 5. Webhook redelivery of the same message, a second ask, and a double tap: nothing more.
  const callsAfterFirst = meta.calls.length;
  const redelivered = await deliver("cust-1", "mid-1");
  assert.equal(redelivered.status, "duplicate_suppressed");
  assert.equal(redelivered.reason, "duplicate_message");
  const askedAgain = await deliver("cust-1", "mid-2");
  assert.equal(askedAgain.status, "duplicate_suppressed");
  assert.equal(askedAgain.reason, "recent_send");
  advance(10_000);
  const tapped = await deliver("cust-1", "mid-3", { explicitResend: true });
  assert.equal(tapped.status, "duplicate_suppressed");
  assert.equal(tapped.reason, "burst_guard");
  assert.equal(meta.calls.length, callsAfterFirst, "redelivery, repeat and double tap send nothing");

  // 6. An explicit "send it again" after the burst window sends again, with the cached attachment.
  advance(2 * 60_000);
  const resent = await deliver("cust-1", "mid-4", { explicitResend: true, lastInboundAt: nowMs - 5_000 });
  assert.equal(resent.status, "sent");
  assert.equal(uploads().length, 1, "the Meta attachment id is reused, the bytes are not uploaded again");
  assert.deepEqual(texts("cust-1").map((call) => call.text), [caption, caption]);
  assert.deepEqual(files("cust-1").map((call) => call.attachmentId), [uploadedId, uploadedId]);

  // 7. Meta refuses the file: the caption already went, ONE link text follows, the file is not claimed sent.
  const failLeads: Lead[] = [];
  meta.failNextFile = { status: 403, code: 200 };
  const refused = await deliver("cust-fail", "mid-f1", {}, failLeads);
  assert.equal(refused.status, "sent_link_fallback");
  assert.equal(refused.fileAccepted, false);
  assert.deepEqual(files("cust-fail"), [{ kind: "file", recipient: "cust-fail", attachmentType: "file", attachmentId: uploadedId, accepted: false }]);
  const refusedTexts = texts("cust-fail").map((call) => call.text);
  assert.equal(refusedTexts.length, 2);
  assert.equal(refusedTexts[0], caption);
  assert.equal(refusedTexts.filter((text) => text.includes(publicUrlOf(draft.publicToken))).length, 1, "exactly one text carries the file link");
  assert.equal(failLeads.length, 1);
  assert.equal(failLeads[0]?.status, "sent_link_fallback");

  // 8. The live data moves on: a dated fare of a printed trip changes. The file is stale and never goes out.
  FRESH.resetFreshnessCacheForTests();
  const moved = liveTrips[2]!;
  liveTrips = liveTrips.map((trip) => trip.id === moved.id
    ? { ...trip, extra: { ...trip.extra, price_groups: [priceRow(trip.departure_dates[0]!, 9_999_000)] } }
    : trip);
  const callsBeforeStale = meta.calls.length;
  const staleLeads: Lead[] = [];
  const stale = await deliver("cust-stale", "mid-s1", {}, staleLeads);
  assert.equal(stale.status, "stale_fallback");
  assert.equal(stale.fileAccepted, false);
  assert.match(String(stale.reason), /^stale:drift/);
  assert.equal(meta.calls.length - callsBeforeStale, 1, "one message, no file, no upload");
  assert.deepEqual(files("cust-stale"), []);
  assert.deepEqual(texts("cust-stale").map((call) => call.text), [MESSAGES.catalogueStaleText(SITE)]);
  assert.ok(texts("cust-stale")[0]!.text.includes(SITE), "the live site link");
  assert.equal(staleLeads.length, 1, "staff follow up on a stale request");
  assert.equal(staleLeads[0]?.status, "stale_fallback");

  // 9. The send log kept one row per outcome, none of them with a customer id.
  assert.deepEqual(
    db.sends.map((row) => row.status).sort(),
    ["sent", "sent", "sent_link_fallback", "stale_fallback", "stale_fallback"],
    "the unpublished ask is logged like the stale one (safe website text), not as a file send",
  );
  assert.ok(db.sends.every((row) => !String(row.sender_hash).includes("cust-")), "sender ids are hashed in the send log");
}

test("catalogue e2e: snapshot -> stand-in PDF -> draft -> publish -> Messenger (no browser needed)", { timeout: 60_000 }, async () => {
  await runFlow(standInPdf());
});

test("catalogue e2e: snapshot -> REAL render -> draft -> publish -> Messenger", { timeout: 240_000 }, async (t) => {
  if (!(await RENDER.isRenderBrowserAvailable())) {
    t.skip("no headless browser on this machine (isRenderBrowserAvailable() is false)");
    return;
  }
  resetWorld();
  const snapshot = DATA.buildCatalogueSnapshot(snapshotInput("quick", new Date(nowMs).toISOString(), liveTrips));
  const rendered = await RENDER.renderCatalogue(snapshot, { pageImages: true, imageFetcher: FIXTURE.sampleImageFetcher(), versionLabel: "e2e" });
  assert.equal(rendered.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(rendered.pageCount >= 3, "cover, trip pages, closing page");
  assert.equal(rendered.pageImages.length, rendered.pageCount);
  assert.ok(rendered.pdf.length < SEND.META_MAX_ATTACHMENT_BYTES);
  await runFlow(rendered);
});
