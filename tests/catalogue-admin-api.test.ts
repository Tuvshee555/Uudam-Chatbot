import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { applyTestEnv } from "./helpers/env";
import { adminBearerHeaders, adminCookieHeaders } from "./helpers/adminAuth";
import type { TravelTrip } from "../src/lib/travelTypes";
import type {
  CatalogueConfig,
  CatalogueEdition,
  CatalogueSnapshot,
  CatalogueTripCard,
  CatalogueVersionMeta,
  CatalogueWarning,
  RenderedCatalogue,
  SnapshotInput,
} from "../src/lib/catalogue/types";
import type { CatalogueAdminDeps } from "../src/lib/catalogue/admin/deps";
import type { TesterLookup, TesterSendTarget } from "../src/lib/catalogue/testers";

// Invented data only: no real trip, place, price or date appears in this file.
const NOW = new Date("2026-06-15T05:00:00.000Z");
const TEST_PSID = "70000000000001";
const OTHER_PSID = "70000000000099";
const TESTER_PSID = "70000000000555";
const TESTER_ID = "11111111-1111-4111-8111-111111111111";
const REVOKED_TESTER_ID = "22222222-2222-4222-8222-222222222222";
const CLOSED_TESTER_ID = "33333333-3333-4333-8333-333333333333";
const PAIRING_CODE = "UUDAM-TEST-ABC234";

const VERSION_DRAFT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION_BLOCKING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSION_OLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSION_LIVE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VERSION_PREVIEW = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const VERSION_SHORT_QUICK = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function trip(id: string): TravelTrip {
  return {
    id,
    category: "Жишиг",
    operator_name: "Тест",
    route_name: `Жишиг-аялал ${id}`,
    duration_text: "5 өдөр",
    adult_price: 1_000_000,
    child_price: null,
    infant_price: null,
    currency: "MNT",
    departure_dates: [],
    seats_total: null,
    seats_left: null,
    has_food: null,
    status: "active",
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: [],
    extra: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function card(id: string, index: number, warnings: CatalogueWarning[] = []): CatalogueTripCard {
  return {
    tripId: id,
    code: `A${String(index + 1).padStart(2, "0")}`,
    title: `Жишиг-аялал ${id}`,
    editorialTitle: `Жишиг ${id}`,
    destinationKey: `dest-${id}`,
    heroQuality: "good",
    gallery: [],
    kicker: "Жишиг / Тест",
    groupKey: "rest",
    durationText: "5 өдөр",
    transportLabel: "Газрын аялал",
    highlights: [],
    price: { kind: "from", amountMnt: 1_000_000, date: "2026-09-01", display: "1,000,000₮-с" },
    dates: { nextDeparture: "2026-09-01", departures: ["2026-09-01"], label: "2026.09.01-ний хөдлөлт" },
    detailUrl: null,
    photo: { url: "https://img.example.test/a.jpg", width: 1600, height: 1000, credit: null, source: "poster_hero" },
    warnings,
  };
}

const TRIP_IDS = Array.from({ length: 14 }, (_, i) => `test-trip-${i + 1}`);
const INELIGIBLE_ID = "test-trip-13";

function meta(overrides: Partial<CatalogueVersionMeta> & { id: string }): CatalogueVersionMeta {
  return {
    edition: "quick",
    versionNo: 1,
    fileName: "UUDAM_Test_2026-06-15_v1.pdf",
    status: "draft",
    sizeBytes: 1_200_000,
    pageCount: 14,
    sha256: "0".repeat(64),
    contentHash: "1".repeat(64),
    tripCount: 10,
    generatedAt: "2026-06-14T00:00:00.000Z",
    generatedBy: "owner.test@example.test",
    publishedAt: null,
    publishedBy: null,
    publicToken: "tok_abcdefghijklmnopqrstuvwxyz",
    warnings: [],
    ...overrides,
  };
}

const BLOCKING: CatalogueWarning = {
  code: "price_conflict",
  severity: "blocking",
  message: "Тайлбар дахь үнэ огнооны үнээс зөрсөн",
  tripId: "test-trip-2",
};

type Fakes = ReturnType<typeof makeFakes>;

function testerTarget(overrides: Partial<TesterSendTarget> & { id: string }): TesterSendTarget {
  return {
    psid: TESTER_PSID, pageId: "1234567890", label: "Миний утас", masked: "…0555", verifiedAt: "2026-06-14T00:00:00.000Z",
    lastInboundAt: new Date(NOW.getTime() - 3_600_000).toISOString(), revokedAt: null, ...overrides,
  };
}

/** An open-window tester, a revoked one, and one whose 24 h window closed. */
function standardTesters(): TesterSendTarget[] {
  return [
    testerTarget({ id: TESTER_ID }),
    testerTarget({ id: REVOKED_TESTER_ID, psid: "70000000000556", revokedAt: "2026-06-14T12:00:00.000Z" }),
    testerTarget({ id: CLOSED_TESTER_ID, psid: "70000000000557", masked: "…0557", label: "", lastInboundAt: new Date(NOW.getTime() - 30 * 3_600_000).toISOString() }),
  ];
}

function makeFakes(options: { allowlist?: string[]; metaDisabled?: boolean; renderFails?: boolean; liveDrift?: boolean; testers?: TesterSendTarget[] } = {}) {
  const calls = {
    schema: 0,
    loadInput: [] as Array<{ edition: CatalogueEdition; opts: unknown }>,
    render: 0,
    drafts: [] as Array<{ edition: CatalogueEdition; snapshot: CatalogueSnapshot; actor: string | null }>,
    saved: [] as Array<{ next: CatalogueConfig; actor: string | null; opts: unknown }>,
    published: [] as Array<{ id: string; actor: string | null; acknowledgeWarnings: boolean }>,
    rolledBack: [] as string[],
    sends: [] as Array<{ recipientPsid: string; edition: CatalogueEdition; dryRun: boolean; versionId: string | null; testerId?: string }>,
    pairing: [] as Array<{ actor: string | null; label: unknown }>,
    revoked: [] as string[],
    candidateQueries: [] as string[],
  };
  const testers = new Map<string, TesterSendTarget>(
    (options.testers ?? []).map((target) => [target.id, target]),
  );
  const lookupOf = (id: string): TesterLookup => {
    const found = testers.get(id);
    return !found ? { status: "not_found" } : found.revokedAt ? { status: "revoked" } : { status: "ok", target: found };
  };
  const PHOTO_CANDIDATES = [
    { url: "https://img.example.test/hero-1.jpg", width: 2400, height: 1600, source: "poster_hero" as const, score: 88, issues: [], credit: null },
    { url: "https://img.example.test/hero-2.jpg", width: 640, height: 480, source: "trip_photo" as const, score: 31, issues: ["нягтрал бага (640px)"], credit: null },
  ];
  let config: CatalogueConfig = {
    quick: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    complete: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    preview: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    heroByTripId: {},
    titleOverrides: {},
    updatedAt: null,
    updatedBy: null,
  };
  const versions = new Map<string, CatalogueVersionMeta>([
    [VERSION_DRAFT, meta({ id: VERSION_DRAFT, versionNo: 3 })],
    [VERSION_BLOCKING, meta({ id: VERSION_BLOCKING, versionNo: 4, warnings: [BLOCKING] })],
    [VERSION_OLD, meta({ id: VERSION_OLD, versionNo: 1, status: "superseded", publishedAt: "2026-05-01T00:00:00.000Z" })],
    [VERSION_LIVE, meta({ id: VERSION_LIVE, versionNo: 2, status: "published", publishedAt: "2026-06-10T00:00:00.000Z", generatedAt: "2026-06-09T00:00:00.000Z" })],
    [VERSION_PREVIEW, meta({ id: VERSION_PREVIEW, edition: "preview", versionNo: 1, tripCount: 2 })],
    [VERSION_SHORT_QUICK, meta({ id: VERSION_SHORT_QUICK, versionNo: 5, tripCount: 5 })],
  ]);
  const pdfBytes = Buffer.from("%PDF-1.7\nfake\n%%EOF");

  const snapshotOf = (edition: CatalogueEdition, input: SnapshotInput): CatalogueSnapshot => {
    const ids = edition === "complete" ? input.trips.map((t) => t.id) : input.config.tripIds;
    const eligible = ids.filter((id) => id !== INELIGIBLE_ID);
    return {
      edition,
      generatedAt: input.nowIso,
      asOfDay: "2026-06-15",
      issueLabel: "2026.06.15",
      seasonLabel: "2026",
      trips: eligible.map((id, i) => card(id, i, id === "test-trip-2" ? [BLOCKING] : [])),
      coverTripId: eligible[0] ?? null,
      groups: [{ key: "rest", label: "Амралт", codes: [] }],
      contact: { phones: ["99990000"], siteLabel: "example.test", siteUrl: "https://example.test" },
      warnings: [],
      contentHash: "h".repeat(64),
    };
  };

  const rendered: RenderedCatalogue = {
    pdf: pdfBytes,
    pageCount: 14,
    pageImages: [],
    pageSize: { width: 540, height: 960 },
    fonts: [],
    renderMs: 12,
    warnings: [],
  };

  const deps: Partial<CatalogueAdminDeps> = {
    store: {
      async ensureCatalogueSchema() { calls.schema += 1; },
      async getCatalogueConfig() { return config; },
      async saveCatalogueConfig(next, actor, opts) {
        calls.saved.push({ next, actor, opts });
        config = { ...next, updatedAt: "2026-06-15T05:00:00.000Z", updatedBy: actor };
        return config;
      },
      async saveDraftVersion(input) {
        calls.drafts.push({ edition: input.edition, snapshot: input.snapshot, actor: input.actor });
        return meta({ id: VERSION_DRAFT, edition: input.edition, versionNo: 9, tripCount: input.snapshot.trips.length });
      },
      async listVersions(edition) {
        return [...versions.values()].filter((v) => !edition || v.edition === edition);
      },
      async getVersionMeta(id) { return versions.get(id) ?? null; },
      async getVersionPdf(id) {
        const found = versions.get(id);
        return found ? { bytes: pdfBytes, meta: found } : null;
      },
      async getVersionPageImage(id, page) {
        return versions.has(id) && page <= 3 ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : null;
      },
      async getVersionSnapshot(id) {
        return versions.has(id) ? snapshotOf("quick", { edition: "quick", nowIso: NOW.toISOString(), trips: [], posterByTripId: {}, config: { ...config.quick, tripIds: TRIP_IDS.slice(0, 8) }, codeMap: {}, contactPhones: [], siteBaseUrl: "" }) : null;
      },
      async publishVersion(id, actor, opts) {
        calls.published.push({ id, actor, acknowledgeWarnings: opts.acknowledgeWarnings });
        return { ...versions.get(id)!, status: "published", publishedAt: NOW.toISOString(), publishedBy: actor };
      },
      async rollbackTo(id, actor) {
        calls.rolledBack.push(id);
        return { ...versions.get(id)!, status: "published", publishedBy: actor };
      },
      async getPublished(edition) {
        return [...versions.values()].find((v) => v.edition === edition && v.status === "published") ?? null;
      },
      async deliveryStats(days) {
        return {
          days,
          since: "2026-06-01T00:00:00.000Z",
          until: NOW.toISOString(),
          totals: { attempts: 4, sent: 3, linkFallback: 0, staleFallback: 0, failed: 1, blocked: 0, noPublishedVersion: 0, dryRun: 0, inFlight: 0, suppressedDuplicates: 2 },
          byStatus: { sent: 3, failed: 1 },
          byVersion: [{ versionId: VERSION_LIVE, edition: "quick", versionNo: 2, fileName: "x.pdf", attempts: 4, delivered: 3, failed: 1 }],
          byDay: [{ day: "2026-06-14", attempts: 4, delivered: 3, failed: 1 }],
          uniqueRecipients: 3,
          successRate: 0.75,
          lastSentAt: "2026-06-14T10:00:00.000Z",
        };
      },
    },
    data: {
      async loadSnapshotInput(edition, opts) {
        calls.loadInput.push({ edition, opts });
        return {
          edition,
          nowIso: opts?.nowIso ?? NOW.toISOString(),
          trips: TRIP_IDS.map(trip),
          posterByTripId: {},
          config: config[edition],
          codeMap: {},
          contactPhones: [],
          siteBaseUrl: "https://example.test",
        };
      },
      buildCatalogueSnapshot(input) { return snapshotOf(input.edition, input); },
      isTripEligible(t) {
        return t.id === INELIGIBLE_ID ? { eligible: false, reason: "Ирээдүйн огноо байхгүй" } : { eligible: true, reason: null };
      },
      liveDrift() {
        return options.liveDrift ? { drifted: true, reasons: ["Нэг аяллын үнэ өөрчлөгдсөн"] } : { drifted: false, reasons: [] };
      },
      async listPhotoCandidates(tripId) {
        calls.candidateQueries.push(tripId);
        return TRIP_IDS.includes(tripId)
          ? { trip: { id: tripId }, candidates: PHOTO_CANDIDATES, chosen: config.heroByTripId[tripId] ?? null }
          : { trip: null, candidates: [], chosen: null };
      },
      async recommendedQuick() {
        const tripIds = TRIP_IDS.slice(0, 10);
        return { tripIds, reasons: Object.fromEntries(tripIds.map((id, i) => [id, `Өөр чиглэл ${i + 1}`])), cover: tripIds[0] };
      },
    },
    testers: {
      async listTesters() {
        const { viewOfTarget } = await import("../src/lib/catalogue/testers");
        return [...testers.values()].filter((target) => !target.revokedAt).map((target) => viewOfTarget(target, NOW));
      },
      async createPairingCode(input) {
        calls.pairing.push({ actor: input.actor, label: input.label });
        return { code: PAIRING_CODE, expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(), ttlMinutes: 30 };
      },
      async revokeTester(id) {
        const found = testers.get(id);
        if (!found || found.revokedAt) return false;
        testers.set(id, { ...found, revokedAt: NOW.toISOString() });
        calls.revoked.push(id);
        return true;
      },
      async getTesterForSend(id) { return lookupOf(id); },
    },
    render: {
      async renderCatalogue() {
        calls.render += 1;
        if (options.renderFails) throw Object.assign(new Error("secret chromium path C:/x"), { name: "CatalogueRenderError", code: "browser_unavailable" });
        return rendered;
      },
    },
    send: {
      async sendCatalogueTest(input) {
        const dryRun = input.dryRun !== false;
        calls.sends.push({ recipientPsid: input.recipientPsid, edition: input.edition, dryRun, versionId: input.versionId ?? null, ...(input.testerId ? { testerId: input.testerId } : {}) });
        const version = versions.get(input.versionId ?? "") ?? versions.get(VERSION_LIVE)!;
        const testerPsid = input.testerId && !dryRun ? testers.get(input.testerId)?.psid ?? "" : "";
        const recipientId = input.recipientPsid || testerPsid || "<test recipient>";
        return {
          status: dryRun ? "dry_run" : "sent",
          versionId: version.id,
          edition: input.edition,
          metaMessageId: dryRun ? null : "m_test_1",
          reason: null,
          fileAccepted: !dryRun,
          ok: true,
          dryRun,
          allowlisted: Boolean(input.recipientPsid),
          recipientMasked: "",
          error: null,
          payload: {
            messages: [
              { kind: "text", body: { messaging_type: "RESPONSE", recipient: { id: recipientId }, message: { text: "Тест тайлбар текст" } } },
              { kind: "file", body: { messaging_type: "RESPONSE", recipient: { id: recipientId }, message: { attachment: { type: "file", payload: { attachment_id: "<attachment_id after upload>" } } } } },
            ],
            textMessages: 1,
            fileAttachments: 1,
            fileName: version.fileName,
            sizeBytes: version.sizeBytes,
            versionNo: version.versionNo,
            edition: input.edition,
            attachmentSource: "upload_on_send",
            publicUrl: "https://example.test/api/catalogue/file/tok",
            fallbackText: "Тест холбоос",
          },
        };
      },
    },
    async listActiveTrips() { return TRIP_IDS.map(trip); },
    testRecipientPsids: () => options.allowlist ?? [],
    metaOutboundDisabled: () => options.metaDisabled === true,
    now: () => NOW,
  };
  return { deps, calls, versions, pdfBytes, setConfig(next: CatalogueConfig) { config = next; } };
}

type TestResponse = {
  statusCode: number;
  headers: Record<string, string | number | readonly string[]>;
  body: Record<string, unknown> & { ok?: boolean; error?: string };
  chunks: Buffer[];
  ended: boolean;
  headersSent: boolean;
  status(code: number): TestResponse;
  json(value: unknown): TestResponse;
  setHeader(name: string, value: string | number | readonly string[]): void;
  write(chunk: Buffer): boolean;
  once(): void;
  end(chunk?: Buffer): TestResponse;
};

function makeResponse(): TestResponse {
  const response: TestResponse = {
    statusCode: 200,
    headers: {},
    body: {},
    chunks: [],
    ended: false,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value as TestResponse["body"]; this.ended = true; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
    once() {},
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.ended = true; return this; },
  };
  return response;
}

type Handler = (req: never, res: never) => Promise<void>;

async function call(
  handler: Handler,
  init: { method?: string; query?: Record<string, string>; body?: unknown; headers?: Record<string, string> | null } = {},
) {
  const res = makeResponse();
  const req = {
    method: init.method ?? "GET",
    url: "/api/admin/catalogue/test",
    headers: init.headers === null ? {} : init.headers ?? adminCookieHeaders(),
    query: init.query ?? {},
    body: init.body,
    socket: { remoteAddress: "127.0.0.1" },
  };
  await handler(req as never, res as never);
  return res;
}

async function routes() {
  const [state, config, trips, generate, versions, publish, rollback, testSend, stats, pdf, page, testers, revoke, photos, recommend] = await Promise.all([
    import("../src/pages/api/admin/catalogue/state"),
    import("../src/pages/api/admin/catalogue/config"),
    import("../src/pages/api/admin/catalogue/trips"),
    import("../src/pages/api/admin/catalogue/generate"),
    import("../src/pages/api/admin/catalogue/versions"),
    import("../src/pages/api/admin/catalogue/publish"),
    import("../src/pages/api/admin/catalogue/rollback"),
    import("../src/pages/api/admin/catalogue/test-send"),
    import("../src/pages/api/admin/catalogue/stats"),
    import("../src/pages/api/admin/catalogue/version/[id]/pdf"),
    import("../src/pages/api/admin/catalogue/version/[id]/page/[n]"),
    import("../src/pages/api/admin/catalogue/testers/index"),
    import("../src/pages/api/admin/catalogue/testers/revoke"),
    import("../src/pages/api/admin/catalogue/photos"),
    import("../src/pages/api/admin/catalogue/recommend"),
  ]);
  return {
    state: state.default as Handler,
    config: config.default as Handler,
    trips: trips.default as Handler,
    generate: generate.default as Handler,
    versions: versions.default as Handler,
    publish: publish.default as Handler,
    rollback: rollback.default as Handler,
    testSend: testSend.default as Handler,
    stats: stats.default as Handler,
    pdf: pdf.default as Handler,
    page: page.default as Handler,
    testers: testers.default as Handler,
    revoke: revoke.default as Handler,
    photos: photos.default as Handler,
    recommend: recommend.default as Handler,
  };
}

let fakes: Fakes;
const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(async () => {
  applyTestEnv();
  const env = await import("../src/lib/env");
  env.resetEnvCacheForTests();
  const rate = await import("../src/lib/rateLimit");
  rate.resetRateLimitForTests();
  (await import("../src/lib/catalogue/freshness")).resetFreshnessCacheForTests();
  fetchCalls = 0;
  // The feature must never reach Meta (or anything else) in these tests.
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("network is not allowed in catalogue admin tests");
  }) as typeof fetch;
  fakes = makeFakes();
  const { setCatalogueAdminDepsForTests } = await import("../src/lib/catalogue/admin/deps");
  setCatalogueAdminDepsForTests(fakes.deps);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  const { setCatalogueAdminDepsForTests } = await import("../src/lib/catalogue/admin/deps");
  setCatalogueAdminDepsForTests(null);
});

async function useFakes(next: Fakes) {
  fakes = next;
  const { setCatalogueAdminDepsForTests } = await import("../src/lib/catalogue/admin/deps");
  setCatalogueAdminDepsForTests(next.deps);
}

const QUICK_EIGHT = TRIP_IDS.slice(0, 8);

test("unauthorized callers get 401 and reach no catalogue module", async () => {
  const r = await routes();
  const jobs: Array<[string, Handler, { method?: string; query?: Record<string, string>; body?: unknown }]> = [
    ["state", r.state, {}],
    ["config GET", r.config, {}],
    ["config PUT", r.config, { method: "PUT", body: { edition: "quick", config: { tripIds: [] } } }],
    ["trips", r.trips, {}],
    ["generate", r.generate, { method: "POST", body: { edition: "quick" } }],
    ["versions", r.versions, {}],
    ["publish", r.publish, { method: "POST", body: { versionId: VERSION_DRAFT } }],
    ["rollback", r.rollback, { method: "POST", body: { versionId: VERSION_OLD } }],
    ["test-send", r.testSend, { method: "POST", body: { edition: "quick" } }],
    ["stats", r.stats, {}],
    ["pdf", r.pdf, { query: { id: VERSION_DRAFT } }],
    ["page", r.page, { query: { id: VERSION_DRAFT, n: "1" } }],
    ["testers GET", r.testers, {}],
    ["testers POST", r.testers, { method: "POST", body: {} }],
    ["testers revoke", r.revoke, { method: "POST", body: { testerId: TESTER_ID } }],
    ["photos GET", r.photos, { query: { tripId: "test-trip-1" } }],
    ["photos PUT", r.photos, { method: "PUT", body: { tripId: "test-trip-1", hero: null } }],
    ["recommend", r.recommend, {}],
  ];
  for (const [name, handler, init] of jobs) {
    const res = await call(handler, { ...init, headers: null });
    assert.equal(res.statusCode, 401, `${name} must be 401 without a session`);
    assert.equal(res.body.ok === true, false, `${name} must not return data`);
    assert.equal(res.headers["cache-control"], "no-store, max-age=0", `${name} is never cached`);
  }
  assert.equal(fakes.calls.schema, 0, "no module was touched");
  assert.equal(fakes.calls.render, 0);
  assert.equal(fakes.calls.sends.length, 0);
});

test("the read-only API token reads but can never write, and a cross-site write is refused", async () => {
  const r = await routes();
  const read = await call(r.versions, { headers: adminBearerHeaders() });
  assert.equal(read.statusCode, 200);
  for (const [handler, method, body] of [
    [r.generate, "POST", { edition: "quick" }],
    [r.publish, "POST", { versionId: VERSION_DRAFT }],
    [r.rollback, "POST", { versionId: VERSION_OLD }],
    [r.testSend, "POST", { edition: "quick" }],
    [r.config, "PUT", { edition: "quick", config: { tripIds: [] } }],
    [r.testers, "POST", {}],
    [r.revoke, "POST", { testerId: TESTER_ID }],
    [r.photos, "PUT", { tripId: "test-trip-1", hero: null }],
  ] as Array<[Handler, string, unknown]>) {
    const res = await call(handler, { method, body, headers: adminBearerHeaders() });
    assert.equal(res.statusCode, 401);
  }
  const crossSite = await call(r.publish, {
    method: "POST",
    body: { versionId: VERSION_DRAFT },
    headers: { ...adminCookieHeaders(), origin: "https://elsewhere.example", host: "admin.example.test" },
  });
  assert.equal(crossSite.statusCode, 401);
  assert.deepEqual(fakes.calls.published, []);
});

test("methods are allow-listed", async () => {
  const r = await routes();
  const res = await call(r.generate, { method: "GET" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers["allow"], "POST");
  assert.equal((await call(r.state, { method: "POST" })).statusCode, 405);
});

test("config rejects malformed and out-of-bounds bodies", async () => {
  const r = await routes();
  const bad: Array<[string, unknown]> = [
    ["not an object", "oops"],
    ["unknown top-level key", { edition: "quick", config: { tripIds: [] }, title: "x" }],
    ["bad edition", { edition: "everything", config: { tripIds: [] } }],
    ["no config", { edition: "quick" }],
    ["trip titles or prices are not accepted", { edition: "quick", config: { tripIds: [], title: "Жишиг", price: 1 } }],
    ["bad trip id", { edition: "quick", config: { tripIds: ["../etc/passwd", ...QUICK_EIGHT.slice(1)] } }],
    ["duplicate ids", { edition: "quick", config: { tripIds: [...QUICK_EIGHT.slice(0, 7), QUICK_EIGHT[0]] } }],
    ["quick: too few", { edition: "quick", config: { tripIds: TRIP_IDS.slice(0, 7) } }],
    ["quick: too many", { edition: "quick", config: { tripIds: TRIP_IDS.slice(0, 13) } }],
    ["featured outside the selection", { edition: "quick", config: { tripIds: QUICK_EIGHT, featuredTripIds: ["test-trip-10"] } }],
    ["excluded inside the selection", { edition: "quick", config: { tripIds: QUICK_EIGHT, excludedTripIds: [QUICK_EIGHT[0]] } }],
    ["bad group key", { edition: "quick", config: { tripIds: QUICK_EIGHT, groupOverrides: { [QUICK_EIGHT[0]]: "Bad Key!" } } }],
    ["preview: too many", { edition: "preview", config: { tripIds: TRIP_IDS.slice(0, 5) } }],
    ["bad expectedUpdatedAt", { edition: "quick", config: { tripIds: [] }, expectedUpdatedAt: "yesterday-ish" }],
  ];
  for (const [name, body] of bad) {
    const res = await call(r.config, { method: "PUT", body });
    assert.equal(res.statusCode, 400, `${name} must be rejected`);
    assert.equal(res.body.ok, false);
    assert.match(String(res.body.message), /[А-Яа-яӨөҮү]/, `${name}: Mongolian message`);
  }
  assert.deepEqual(fakes.calls.saved, [], "nothing was written");
});

test("config saves a valid quick selection of 8..12 and refuses trips that cannot be sold", async () => {
  const r = await routes();
  const ineligible = await call(r.config, {
    method: "PUT",
    body: { edition: "quick", config: { tripIds: [...QUICK_EIGHT.slice(0, 7), INELIGIBLE_ID] } },
  });
  assert.equal(ineligible.statusCode, 422);
  assert.equal(ineligible.body.error, "trip_not_selectable");
  assert.deepEqual((ineligible.body.problems as Array<{ tripId: string }>).map((p) => p.tripId), [INELIGIBLE_ID]);

  const unknown = await call(r.config, {
    method: "PUT",
    body: { edition: "quick", config: { tripIds: [...QUICK_EIGHT.slice(0, 7), "test-trip-404"] } },
  });
  assert.equal(unknown.statusCode, 422);

  for (const count of [8, 12]) {
    const ids = TRIP_IDS.slice(0, count === 12 ? 12 : 8).filter((id) => id !== INELIGIBLE_ID).slice(0, count);
    assert.equal(ids.length, count);
    const ok = await call(r.config, {
      method: "PUT",
      body: {
        edition: "quick",
        expectedUpdatedAt: null,
        config: { tripIds: ids, featuredTripIds: [ids[0]], groupOverrides: { [ids[1]]: "rest", "test-trip-gone": "rest" }, excludedTripIds: ["test-trip-13", "test-trip-gone"] },
      },
    });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    const saved = fakes.calls.saved.at(-1)!;
    assert.deepEqual(saved.next.quick.tripIds, ids);
    assert.deepEqual(saved.next.quick.featuredTripIds, [ids[0]]);
    assert.deepEqual(saved.next.quick.groupOverrides, { [ids[1]]: "rest" }, "a trip that no longer exists is dropped");
    assert.deepEqual(saved.next.quick.excludedTripIds, ["test-trip-13"]);
    assert.equal(saved.actor, "owner.test@example.test");
    assert.deepEqual(saved.opts, { expectedUpdatedAt: null });
    assert.equal(saved.next.complete.tripIds.length, 0, "other editions are untouched");
  }
});

test("generate refuses a Quick selection outside 8..12 before rendering, and an unavailable renderer", async () => {
  const r = await routes();
  fakes.setConfig({ ...(await fakes.deps.store!.getCatalogueConfig()), quick: { tripIds: TRIP_IDS.slice(0, 7), groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] } });
  const short = await call(r.generate, { method: "POST", body: { edition: "quick" } });
  assert.equal(short.statusCode, 422);
  assert.equal(short.body.error, "selection_out_of_bounds");
  assert.equal(fakes.calls.render, 0, "nothing is rendered for an invalid selection");
  assert.equal(fakes.calls.drafts.length, 0);

  const broken = makeFakes({ renderFails: true });
  await useFakes(broken);
  const unavailable = await call(r.generate, { method: "POST", body: { edition: "complete" } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.error, "render_unavailable");
  assert.equal(JSON.stringify(unavailable.body).includes("secret"), false, "renderer internals are never echoed");
  assert.equal(broken.calls.drafts.length, 0, "no draft is stored for a failed render");
  const retry = await call(r.generate, { method: "POST", body: { edition: "complete" } });
  assert.equal(retry.statusCode, 503, "a failed render does not leave the edition locked");

  const bad = await call(r.generate, { method: "POST", body: { edition: "weekly" } });
  assert.equal(bad.statusCode, 400);
  const extra = await call(r.generate, { method: "POST", body: { edition: "quick", tripIds: ["x"] } });
  assert.equal(extra.statusCode, 400, "trip lists are not accepted here; curation lives in config");
});

test("generate builds ONE snapshot, renders it once and stores a draft; nothing is published or sent", async () => {
  const r = await routes();
  fakes.setConfig({ ...(await fakes.deps.store!.getCatalogueConfig()), quick: { tripIds: TRIP_IDS.slice(0, 10), groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] } });
  const res = await call(r.generate, { method: "POST", body: { edition: "quick" } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(fakes.calls.loadInput.length, 1, "one consistent snapshot input");
  assert.equal(fakes.calls.render, 1);
  assert.equal(fakes.calls.drafts.length, 1);
  assert.equal(fakes.calls.drafts[0].snapshot.edition, "quick");
  assert.equal(fakes.calls.drafts[0].actor, "owner.test@example.test");
  assert.deepEqual(fakes.calls.published, []);
  assert.deepEqual(fakes.calls.sends, []);
  const version = res.body.version as { id: string; downloadPath: string; status: string };
  assert.equal(version.status, "draft");
  assert.match(version.downloadPath, /\/api\/admin\/catalogue\/version\/.+\/pdf$/);
  assert.equal((res.body.summary as { pages: number }).pages, 14);
  assert.equal(fetchCalls, 0);

  // A complete catalogue with a lot of trips has no 8..12 limit.
  const complete = await call(r.generate, { method: "POST", body: { edition: "complete" } });
  assert.equal(complete.statusCode, 200);
});

test("publish: blocking warnings need an explicit acknowledgement", async () => {
  const r = await routes();
  const refused = await call(r.publish, { method: "POST", body: { versionId: VERSION_BLOCKING } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.error, "blocking_warnings_unacknowledged");
  assert.equal((refused.body.blocking as unknown[]).length, 1);
  assert.deepEqual(fakes.calls.published, [], "the store was never asked to publish");

  const falsy = await call(r.publish, { method: "POST", body: { versionId: VERSION_BLOCKING, acknowledgeWarnings: "yes" } });
  assert.equal(falsy.statusCode, 400, "only a real boolean acknowledges");

  const accepted = await call(r.publish, { method: "POST", body: { versionId: VERSION_BLOCKING, acknowledgeWarnings: true } });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(fakes.calls.published, [{ id: VERSION_BLOCKING, actor: "owner.test@example.test", acknowledgeWarnings: true }]);

  const clean = await call(r.publish, { method: "POST", body: { versionId: VERSION_DRAFT } });
  assert.equal(clean.statusCode, 200);
  const publishedCalls: Array<{ id: string; acknowledgeWarnings: boolean }> = [...fakes.calls.published];
  assert.deepEqual(publishedCalls.map((entry) => [entry.id, entry.acknowledgeWarnings]), [
    [VERSION_BLOCKING, true],
    [VERSION_DRAFT, false],
  ], "a clean draft publishes without any acknowledgement");
});

test("publish validates the version it is asked to publish", async () => {
  const r = await routes();
  assert.equal((await call(r.publish, { method: "POST", body: {} })).statusCode, 400);
  assert.equal((await call(r.publish, { method: "POST", body: { versionId: "../x" } })).statusCode, 400);
  assert.equal((await call(r.publish, { method: "POST", body: { versionId: VERSION_DRAFT, extra: 1 } })).statusCode, 400);
  assert.equal((await call(r.publish, { method: "POST", body: { versionId: "99999999-9999-4999-8999-999999999999" } })).statusCode, 404);
  assert.equal((await call(r.publish, { method: "POST", body: { versionId: VERSION_PREVIEW } })).statusCode, 422, "the sample is never published");
  assert.equal((await call(r.publish, { method: "POST", body: { versionId: VERSION_LIVE } })).statusCode, 409, "already published");
  assert.equal((await call(r.publish, { method: "POST", body: { versionId: VERSION_OLD } })).statusCode, 409, "history is restored by rollback");
  const short = await call(r.publish, { method: "POST", body: { versionId: VERSION_SHORT_QUICK, acknowledgeWarnings: true } });
  assert.equal(short.statusCode, 422, "a Quick draft outside 8..12 trips cannot be published, acknowledged or not");
  assert.deepEqual(fakes.calls.published, []);
});

test("rollback restores only a previously published version", async () => {
  const r = await routes();
  const ok = await call(r.rollback, { method: "POST", body: { versionId: VERSION_OLD } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(fakes.calls.rolledBack, [VERSION_OLD]);
  assert.equal((await call(r.rollback, { method: "POST", body: { versionId: VERSION_DRAFT } })).statusCode, 409);
  assert.equal((await call(r.rollback, { method: "POST", body: { versionId: VERSION_LIVE } })).statusCode, 409);
  assert.equal((await call(r.rollback, { method: "POST", body: { versionId: VERSION_PREVIEW } })).statusCode, 422);
  assert.equal((await call(r.rollback, { method: "POST", body: {} })).statusCode, 400);
  assert.deepEqual(fakes.calls.rolledBack, [VERSION_OLD]);
});

test("test-send: the default is a dry-run that never reaches Meta and shows the exact two requests", async () => {
  await useFakes(makeFakes({ allowlist: [TEST_PSID] }));
  const r = await routes();
  const res = await call(r.testSend, { method: "POST", body: { edition: "quick", recipientRef: (await import("../src/lib/catalogue/admin/deps")).recipientRef(TEST_PSID) } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.dryRun, true);
  assert.deepEqual(fakes.calls.sends, [{ recipientPsid: "", edition: "quick", dryRun: true, versionId: VERSION_LIVE }], "a dry-run addresses nobody");
  assert.equal(fetchCalls, 0, "dry-run makes no network request at all");
  const payload = res.body.payload as { messages: Array<{ kind: string; body: { message: { attachment?: { type: string }; text?: string } } }>; file: { name: string }; recipient: string };
  assert.equal(payload.messages.length, 2, "one text and one file attachment");
  assert.deepEqual(payload.messages.map((m) => m.kind), ["text", "file"]);
  assert.equal(payload.messages[0].body.message.text, "Тест тайлбар текст");
  assert.equal(payload.messages[1].body.message.attachment?.type, "file");
  assert.ok(payload.file.name.endsWith(".pdf"));
  assert.equal(JSON.stringify(res.body).includes(TEST_PSID), false, "the full PSID never leaves the server");
  assert.equal((res.body.outcome as { metaMessageId: string | null }).metaMessageId, null);
});

test("test-send: dry-run works with no recipient configured and addresses nobody", async () => {
  const r = await routes();
  const res = await call(r.testSend, { method: "POST", body: { edition: "quick", dryRun: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(fakes.calls.sends, [{ recipientPsid: "", edition: "quick", dryRun: true, versionId: VERSION_LIVE }]);
  assert.equal((res.body.outcome as { status: string }).status, "dry_run");
  assert.equal(fetchCalls, 0);
});

test("test-send can dry-run a draft or the sample before they are published, but not history", async () => {
  const r = await routes();
  const draft = await call(r.testSend, { method: "POST", body: { versionId: VERSION_DRAFT } });
  assert.equal(draft.statusCode, 200, JSON.stringify(draft.body));
  assert.equal(draft.body.versionId, VERSION_DRAFT);
  assert.deepEqual(fakes.calls.sends, [{ recipientPsid: "", edition: "quick", dryRun: true, versionId: VERSION_DRAFT }]);
  assert.equal((await call(r.testSend, { method: "POST", body: { versionId: VERSION_OLD } })).statusCode, 409);
  const sample = await call(r.testSend, { method: "POST", body: { versionId: VERSION_PREVIEW } });
  assert.equal(sample.statusCode, 200, "the preview sample can be looked at (dry-run)");
  assert.equal(sample.body.edition, "preview");
  assert.equal((await call(r.testSend, { method: "POST", body: { versionId: VERSION_DRAFT, edition: "complete" } })).statusCode, 400);
  assert.equal((await call(r.testSend, { method: "POST", body: { versionId: "../x" } })).statusCode, 400);
  assert.equal((await call(r.testSend, { method: "POST", body: { versionId: "99999999-9999-4999-8999-999999999999" } })).statusCode, 404);
  assert.equal(fakes.calls.sends.length, 2, "refused requests never reached the sender (draft and sample only)");
});

test("test-send: a non-allowlisted PSID is refused in both modes", async () => {
  await useFakes(makeFakes({ allowlist: [TEST_PSID] }));
  const r = await routes();
  for (const body of [
    { edition: "quick", recipientPsid: OTHER_PSID },
    { edition: "quick", dryRun: false, confirm: true, recipientPsid: OTHER_PSID },
    { edition: "quick", dryRun: false, confirm: true, recipientRef: "0123456789abcdef" },
  ]) {
    const res = await call(r.testSend, { method: "POST", body });
    assert.equal(res.statusCode, 403, JSON.stringify(body));
    assert.equal(res.body.error, "recipient_not_allowed");
  }
  assert.deepEqual(fakes.calls.sends, []);
  assert.equal(fetchCalls, 0);
});

test("test-send: a real send needs an allowlist, an explicit confirm and an active Meta switch", async () => {
  const r = await routes();
  const none = await call(r.testSend, { method: "POST", body: { edition: "quick", dryRun: false, confirm: true, recipientPsid: TEST_PSID } });
  assert.equal(none.statusCode, 403, "with no allowlist every PSID is non-allowlisted");

  await useFakes(makeFakes({ allowlist: [TEST_PSID] }));
  const unconfirmed = await call(r.testSend, { method: "POST", body: { edition: "quick", dryRun: false, recipientPsid: TEST_PSID } });
  assert.equal(unconfirmed.statusCode, 400);
  const nobody = await call(r.testSend, { method: "POST", body: { edition: "quick", dryRun: false, confirm: true } });
  assert.equal(nobody.statusCode, 400, "a real send always names its recipient");
  assert.deepEqual(fakes.calls.sends, []);

  await useFakes(makeFakes({ allowlist: [TEST_PSID], metaDisabled: true }));
  const killed = await call(r.testSend, { method: "POST", body: { edition: "quick", dryRun: false, confirm: true, recipientPsid: TEST_PSID } });
  assert.equal(killed.statusCode, 409);
  assert.equal(killed.body.error, "meta_outbound_disabled");
  assert.deepEqual(fakes.calls.sends, []);

  await useFakes(makeFakes({ allowlist: [TEST_PSID] }));
  const { recipientRef } = await import("../src/lib/catalogue/admin/deps");
  const sent = await call(r.testSend, { method: "POST", body: { edition: "quick", dryRun: false, confirm: true, recipientRef: recipientRef(TEST_PSID) } });
  assert.equal(sent.statusCode, 200, JSON.stringify(sent.body));
  assert.deepEqual(fakes.calls.sends, [{ recipientPsid: TEST_PSID, edition: "quick", dryRun: false, versionId: VERSION_LIVE }]);
  assert.equal(sent.body.dryRun, false);
  assert.equal((sent.body.outcome as { metaMessageId: string }).metaMessageId, "m_test_1");
  assert.equal(JSON.stringify(sent.body).includes(TEST_PSID), false);
});

test("test-send needs a published version and refuses the preview edition", async () => {
  await useFakes(makeFakes({ allowlist: [TEST_PSID] }));
  const r = await routes();
  assert.equal((await call(r.testSend, { method: "POST", body: { edition: "preview" } })).statusCode, 400);
  fakes.versions.delete(VERSION_LIVE);
  const res = await call(r.testSend, { method: "POST", body: { edition: "quick" } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "no_published_version");
});

test("state reports published versions, freshness, readiness and a masked recipient list", async () => {
  await useFakes(makeFakes({ allowlist: [TEST_PSID], liveDrift: true }));
  const r = await routes();
  const res = await call(r.state);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const body = res.body as unknown as {
    editions: { quick: { published: { id: string; publicPath: string | null; downloadPath: string }; latestDraft: { id: string }; freshness: { status: string; reasons: string[] } }; complete: { published: null } };
    testSend: { recipients: Array<{ ref: string; label: string }>; realSendPossible: boolean; blockedReason: string | null };
    limits: { quickMin: number; quickMax: number };
  };
  assert.equal(body.editions.quick.published.id, VERSION_LIVE);
  assert.match(body.editions.quick.published.publicPath ?? "", /^\/api\/catalogue\/file\//);
  assert.equal(body.editions.quick.latestDraft.id, VERSION_SHORT_QUICK, "newest draft by version number");
  assert.equal(body.editions.quick.freshness.status, "stale");
  assert.ok(body.editions.quick.freshness.reasons.some((reason) => reason.includes("өөрчлөгдсөн")));
  assert.equal(body.editions.complete.published, null);
  assert.deepEqual(body.limits.quickMin, 8);
  assert.deepEqual(body.limits.quickMax, 12);
  assert.equal(body.testSend.realSendPossible, true);
  assert.equal(body.testSend.recipients[0].label, "…0001");
  assert.equal(JSON.stringify(res.body).includes(TEST_PSID), false);
});

test("state: no allowlist disables real sending and says why; an old version is stale by age alone", async () => {
  const r = await routes();
  const res = await call(r.state);
  const body = res.body as unknown as { testSend: { realSendPossible: boolean; blockedReason: string; recipients: unknown[] }; editions: { quick: { freshness: { status: string; ageDays: number } } } };
  assert.equal(body.testSend.realSendPossible, false);
  assert.equal(body.testSend.recipients.length, 0);
  assert.match(body.testSend.blockedReason, /Тестер холбох/);
  assert.doesNotMatch(body.testSend.blockedReason, /Vercel|CATALOGUE_TEST_RECIPIENT_PSIDS/, "no hunting for ids, no variables to edit");
  assert.equal(body.editions.quick.freshness.status, "fresh", "6 days old with unchanged data");

  fakes.versions.set(VERSION_LIVE, meta({ id: VERSION_LIVE, versionNo: 2, status: "published", generatedAt: "2026-05-01T00:00:00.000Z" }));
  const stale = await call(r.state);
  const staleBody = stale.body as unknown as { editions: { quick: { freshness: { status: string; ageDays: number; reasons: string[] } } } };
  assert.equal(staleBody.editions.quick.freshness.status, "stale");
  assert.equal(staleBody.editions.quick.freshness.ageDays, 45);
});

test("trips review lists live facts, eligibility reasons and warnings; nothing is written", async () => {
  const r = await routes();
  fakes.setConfig({ ...(await fakes.deps.store!.getCatalogueConfig()), quick: { tripIds: ["test-trip-2", "test-trip-1"], groupOverrides: { "test-trip-1": "rest" }, featuredTripIds: ["test-trip-2"], excludedTripIds: [] } });
  const res = await call(r.trips, { query: { edition: "quick" } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const body = res.body as unknown as { rows: Array<Record<string, unknown>>; counts: { active: number; eligible: number; blocking: number } };
  assert.equal(body.counts.active, 14);
  assert.equal(body.counts.eligible, 13);
  assert.equal(body.counts.blocking, 1);
  const first = body.rows[0];
  assert.equal(first.tripId, "test-trip-2", "curated order comes first");
  assert.equal(first.severity, "blocking");
  assert.equal(first.featured, true);
  assert.equal(first.priceDate, "2026-09-01");
  assert.equal(first.priceSource, "dated_fare");
  const second = body.rows[1];
  assert.equal(second.position, 2);
  assert.equal(second.groupOverride, "rest");
  const ineligible = body.rows.find((row) => row.tripId === INELIGIBLE_ID)!;
  assert.equal(ineligible.eligible, false);
  assert.equal(ineligible.eligibilityReason, "Ирээдүйн огноо байхгүй");
  assert.deepEqual(fakes.calls.saved, []);
  assert.equal((await call(r.trips, { query: { edition: "nope" } })).statusCode, 400);
});

test("REGRESSION: the review table is served read-only, so a read-only bearer GET can never allocate trip codes", async () => {
  const r = await routes();
  const res = await call(r.trips, { query: { edition: "complete" }, headers: adminBearerHeaders() });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(fakes.calls.loadInput.length >= 1);
  for (const load of fakes.calls.loadInput) {
    assert.equal((load.opts as { readOnlyCodes?: boolean }).readOnlyCodes, true, "loadSnapshotInput must be told not to allocate");
  }
  assert.deepEqual(fakes.calls.saved, []);
});

test("review rows show a trip that has no stored code with a null code, never an in-memory placeholder", async () => {
  const { loadReview } = await import("../src/lib/catalogue/admin/review");
  const base = fakes.deps.data!;
  const data = {
    ...base,
    buildCatalogueSnapshot(input: SnapshotInput) {
      const snap = base.buildCatalogueSnapshot(input);
      return { ...snap, trips: snap.trips.map((c) => (c.tripId === "test-trip-2" ? { ...c, code: "~001" } : c)) };
    },
  };
  const review = await loadReview({
    edition: "complete",
    nowIso: NOW.toISOString(),
    today: "2026-06-15",
    activeTrips: [trip("test-trip-1"), trip("test-trip-2")],
    editionConfig: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    data,
  });
  const byId = new Map(review.rows.map((row) => [row.tripId, row]));
  assert.equal(byId.get("test-trip-1")?.code, "A01");
  assert.equal(byId.get("test-trip-2")?.code, null);
  assert.equal(byId.get("test-trip-2")?.eligible, true, "the trip itself is still reviewed");
});

test("versions and stats are bounded and carry counts only", async () => {
  const r = await routes();
  const list = await call(r.versions, { query: { edition: "quick", limit: "5" } });
  assert.equal(list.statusCode, 200);
  assert.equal((list.body.versions as unknown[]).length, 5);
  assert.equal((await call(r.versions, { query: { edition: "bogus" } })).statusCode, 400);

  const stats = await call(r.stats, { query: { days: "400" } });
  assert.equal(stats.statusCode, 200);
  assert.equal(stats.body.days, 14, "never more than 14 days");
  assert.equal((stats.body.totals as { failed: number }).failed, 1);
  assert.equal(JSON.stringify(stats.body).toLowerCase().includes("sender"), false);
});

test("pdf download streams any version as an application/pdf attachment", async () => {
  const r = await routes();
  const res = await call(r.pdf, { query: { id: VERSION_DRAFT } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/pdf");
  assert.match(String(res.headers["content-disposition"]), /^attachment; filename="UUDAM_Test_2026-06-15_v1\.pdf"/);
  assert.equal(res.headers["content-length"], String(fakes.pdfBytes.length));
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(Buffer.concat(res.chunks), fakes.pdfBytes);

  const inline = await call(r.pdf, { query: { id: VERSION_DRAFT, disposition: "inline" } });
  assert.match(String(inline.headers["content-disposition"]), /^inline;/);
  assert.equal((await call(r.pdf, { query: { id: "99999999-9999-4999-8999-999999999999" } })).statusCode, 404);
  assert.equal((await call(r.pdf, { query: { id: "a/b" } })).statusCode, 400);
});

test("page images are served as JPEG for valid page numbers only", async () => {
  const r = await routes();
  const res = await call(r.page, { query: { id: VERSION_DRAFT, n: "2" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.deepEqual(Buffer.concat(res.chunks), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal((await call(r.page, { query: { id: VERSION_DRAFT, n: "0" } })).statusCode, 400);
  assert.equal((await call(r.page, { query: { id: VERSION_DRAFT, n: "x" } })).statusCode, 400);
  assert.equal((await call(r.page, { query: { id: VERSION_DRAFT, n: "99" } })).statusCode, 404);
});

test("store errors become precise Mongolian answers, not a blank 500", async () => {
  const r = await routes();
  const store = fakes.deps.store!;
  store.publishVersion = async () => {
    throw Object.assign(new Error("blocking_warnings"), { name: "CatalogueStoreError", code: "blocking_warnings" });
  };
  const res = await call(r.publish, { method: "POST", body: { versionId: VERSION_DRAFT } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "blocking_warnings");
  assert.match(String(res.body.message), /анхааруулга/);

  store.getVersionMeta = async () => {
    throw new Error("connection string postgres://user:secret@host/db leaked");
  };
  const failed = await call(r.publish, { method: "POST", body: { versionId: VERSION_DRAFT } });
  assert.equal(failed.statusCode, 500);
  assert.equal(JSON.stringify(failed.body).includes("secret"), false, "internal errors are never echoed");
});

test("the review table surfaces the overview-vs-dated price conflict as a blocking row", async () => {
  const { buildReviewRows } = await import("../src/lib/catalogue/admin/review");
  const conflict: CatalogueWarning = {
    code: "price_conflict",
    severity: "blocking",
    message: "Тайлбарт 3,880,000₮, огнооны үнэ 3,980,000₮",
    tripId: "test-dalai",
    detail: { overviewMnt: 3_880_000, datedMnt: 3_980_000 },
  };
  const photoless = { ...card("test-hodoo", 1, [{ code: "photo_missing", severity: "warning", message: "Зураг алга", tripId: "test-hodoo" }]), photo: null };
  const snapshot: CatalogueSnapshot = {
    edition: "complete",
    generatedAt: NOW.toISOString(),
    asOfDay: "2026-06-15",
    issueLabel: "2026.06.15",
    seasonLabel: "2026",
    trips: [{ ...card("test-dalai", 0, [conflict]), price: { kind: "from", amountMnt: 3_980_000, date: "2026-09-01", display: "3,980,000₮-с" } }, photoless],
    coverTripId: "test-dalai",
    groups: [{ key: "rest", label: "Амралт", codes: ["A01", "A02"] }],
    contact: { phones: [], siteLabel: "", siteUrl: "" },
    warnings: [],
    contentHash: "h".repeat(64),
  };
  const review = buildReviewRows({
    edition: "complete",
    today: "2026-06-15",
    activeTrips: [trip("test-dalai"), trip("test-hodoo"), trip("test-old")],
    snapshot,
    eligibility: new Map([
      ["test-dalai", { eligible: true, reason: null }],
      ["test-hodoo", { eligible: true, reason: null }],
      ["test-old", { eligible: false, reason: "Бүх огноо өнгөрсөн" }],
    ]),
    config: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: ["test-hodoo"] },
    codeMap: {},
  });
  const dalai = review.rows.find((row) => row.tripId === "test-dalai")!;
  assert.equal(dalai.severity, "blocking");
  assert.equal(dalai.priceAmountMnt, 3_980_000, "the dated fare, not the prose price, is what is printed");
  assert.equal(dalai.warnings[0].code, "price_conflict");
  const hodoo = review.rows.find((row) => row.tripId === "test-hodoo")!;
  assert.equal(hodoo.severity, "warning");
  assert.equal(hodoo.photo, null);
  assert.match(hodoo.photoSourceLabel, /Зураггүй/);
  assert.equal(hodoo.excluded, true);
  assert.equal(hodoo.selected, false, "excluded trips are not part of the Complete catalogue");
  const old = review.rows.find((row) => row.tripId === "test-old")!;
  assert.equal(old.eligible, false);
  assert.equal(old.eligibilityReason, "Бүх огноо өнгөрсөн");
  assert.deepEqual(review.counts, { active: 3, eligible: 2, blocking: 1, warning: 1 });
});

test("curation draft helpers keep the Quick selection inside its bounds and in order", async () => {
  const draftLib = await import("../src/components/admin/catalogue/curationDraft");
  let draft = draftLib.draftFromConfig({ tripIds: ["a", "b", "c"], groupOverrides: {}, featuredTripIds: ["b"], excludedTripIds: ["x"] });
  draft = draftLib.moveTrip(draft, "c", -1);
  assert.deepEqual(draft.tripIds, ["a", "c", "b"]);
  assert.deepEqual(draftLib.moveTrip(draft, "a", -1).tripIds, ["a", "c", "b"], "no move past the top");
  assert.deepEqual(draftLib.moveTrip(draft, "b", 1).tripIds, ["a", "c", "b"], "no move past the bottom");
  draft = draftLib.removeTrip(draft, "b");
  assert.deepEqual(draft.featured, [], "removing a trip also un-features it");
  assert.equal(draftLib.addTrip(draft, "a", 12), draft, "no duplicates");
  const full = draftLib.draftFromConfig({ tripIds: TRIP_IDS.slice(0, 12), groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] });
  assert.equal(draftLib.addTrip(full, "extra", 12), full, "the 13th trip is refused");
  assert.deepEqual(draftLib.setGroupOverride(draft, "a", "rest").overrides, { a: "rest" });
  assert.deepEqual(draftLib.setGroupOverride(draftLib.setGroupOverride(draft, "a", "rest"), "a", "").overrides, {});
  assert.equal(draftLib.selectionStatus("quick", 7).ok, false);
  assert.equal(draftLib.selectionStatus("quick", 8).ok, true);
  assert.equal(draftLib.selectionStatus("quick", 12).ok, true);
  assert.equal(draftLib.selectionStatus("quick", 13).ok, false);
  const config = draftLib.draftToConfig({ tripIds: ["a"], featured: ["a", "gone"], excluded: ["a", "z"], overrides: {} });
  assert.deepEqual(config.featuredTripIds, ["a"]);
  assert.deepEqual(config.excludedTripIds, ["z"], "a selected trip is never also excluded");
  assert.equal(draftLib.isDirty(draftLib.draftFromConfig(config), draftLib.draftFromConfig(config)), false);
});

// ── Verified testers: "Тестер холбох" ─────────────────────────────────────────────────────────────

test("pairing: a signed-in admin gets a one-time code; the read-only token and strangers cannot", async () => {
  const r = await routes();
  const res = await call(r.testers, { method: "POST", body: { label: "Миний утас" } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.code, PAIRING_CODE);
  assert.equal(res.body.ttlMinutes, 30);
  assert.match(String(res.body.instruction), /Messenger/);
  assert.equal(fakes.calls.pairing.length, 1);
  assert.equal(fakes.calls.pairing[0].label, "Миний утас");
  assert.match(String(fakes.calls.pairing[0].actor), /@/, "the code is tied to the signed-in staff member");
  assert.equal((await call(r.testers, { method: "POST", body: {}, headers: adminBearerHeaders() })).statusCode, 401, "the read-only token cannot mint a code");
  assert.equal((await call(r.testers, { method: "POST", body: { label: "x".repeat(41) } })).statusCode, 400, "labels are short");
  assert.equal((await call(r.testers, { method: "POST", body: { label: "a", extra: 1 } })).statusCode, 400);
  assert.equal(fakes.calls.pairing.length, 1);
});

test("pairing: the list shows label, masked tail and window state; no PSID and no code ever reaches the browser", async () => {
  await useFakes(makeFakes({ testers: standardTesters() }));
  const r = await routes();
  const res = await call(r.testers, { headers: adminBearerHeaders() });
  assert.equal(res.statusCode, 200);
  const testers = res.body.testers as Array<{ id: string; label: string; masked: string; windowOpen: boolean; windowClosesAt: string | null; verifiedAt: string }>;
  assert.deepEqual(testers.map((t) => t.id).sort(), [CLOSED_TESTER_ID, TESTER_ID].sort(), "revoked testers are not listed");
  const open = testers.find((t) => t.id === TESTER_ID)!;
  assert.equal(open.label, "Миний утас");
  assert.equal(open.masked, "…0555");
  assert.equal(open.windowOpen, true);
  assert.ok(open.windowClosesAt && Date.parse(open.windowClosesAt) > NOW.getTime());
  const closed = testers.find((t) => t.id === CLOSED_TESTER_ID)!;
  assert.equal(closed.windowOpen, false);
  assert.equal(closed.windowClosesAt, null);
  const text = JSON.stringify(res.body);
  for (const secret of [TESTER_PSID, "70000000000557", "psid"]) assert.equal(text.includes(secret), false, `${secret} must not reach the browser`);
  assert.equal(text.includes(PAIRING_CODE), false);
});

test("revoking a tester is a signed-in write and the tester is gone", async () => {
  await useFakes(makeFakes({ testers: standardTesters() }));
  const r = await routes();
  assert.equal((await call(r.revoke, { method: "POST", body: { testerId: TESTER_ID }, headers: adminBearerHeaders() })).statusCode, 401);
  assert.equal((await call(r.revoke, { method: "POST", body: { testerId: "not-a-uuid" } })).statusCode, 400);
  assert.equal((await call(r.revoke, { method: "POST", body: { testerId: TESTER_ID } })).statusCode, 200);
  assert.deepEqual(fakes.calls.revoked, [TESTER_ID]);
  assert.equal((await call(r.revoke, { method: "POST", body: { testerId: TESTER_ID } })).statusCode, 404, "already revoked");
  const list = await call(r.testers);
  assert.equal((list.body.testers as Array<{ id: string }>).some((t) => t.id === TESTER_ID), false);
});

test("state: with no tester and no env recipient it names the one live-device step; with a tester the window decides", async () => {
  const r = await routes();
  const none = (await call(r.state)).body as unknown as { testSend: { testers: unknown[]; realSendPossible: boolean; blockedReason: string; pairingCodeTtlMinutes: number } };
  assert.equal(none.testSend.testers.length, 0);
  assert.equal(none.testSend.realSendPossible, false);
  assert.match(none.testSend.blockedReason, /«Тестер холбох»/);
  assert.match(none.testSend.blockedReason, /Messenger-ээс манай Page руу/);
  assert.equal(none.testSend.pairingCodeTtlMinutes, 30);

  await useFakes(makeFakes({ testers: standardTesters() }));
  const ready = (await call(r.state)).body as unknown as { testSend: { testers: Array<{ windowOpen: boolean }>; realSendPossible: boolean; blockedReason: string | null } };
  assert.equal(ready.testSend.realSendPossible, true);
  assert.equal(ready.testSend.blockedReason, null);
  assert.equal(ready.testSend.testers.length, 2);

  await useFakes(makeFakes({ testers: [standardTesters()[2]] }));
  const closed = (await call(r.state)).body as unknown as { testSend: { realSendPossible: boolean; blockedReason: string } };
  assert.equal(closed.testSend.realSendPossible, false);
  assert.match(closed.testSend.blockedReason, /24 цагийн цонх/);

  await useFakes(makeFakes({ testers: standardTesters(), metaDisabled: true }));
  const killed = (await call(r.state)).body as unknown as { testSend: { realSendPossible: boolean; blockedReason: string } };
  assert.equal(killed.testSend.realSendPossible, false);
  assert.match(killed.testSend.blockedReason, /унтраалттай/);
});

test("test-send to a verified tester: dry-run addresses nobody; the real send is masked, confirmed and window-checked", async () => {
  await useFakes(makeFakes({ testers: standardTesters() }));
  const r = await routes();
  const dry = await call(r.testSend, { method: "POST", body: { edition: "quick", testerId: TESTER_ID } });
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
  assert.deepEqual(fakes.calls.sends, [{ recipientPsid: "", edition: "quick", dryRun: true, versionId: VERSION_LIVE, testerId: TESTER_ID }]);
  const dryPayload = dry.body.payload as { messages: Array<{ kind: string }> };
  assert.deepEqual(dryPayload.messages.map((m) => m.kind), ["text", "file"], "exactly one text and one file");
  const testerView = dry.body.tester as { id: string; label: string; masked: string; windowOpen: boolean };
  assert.deepEqual([testerView.id, testerView.label, testerView.masked, testerView.windowOpen], [TESTER_ID, "Миний утас", "…0555", true]);

  const unconfirmed = await call(r.testSend, { method: "POST", body: { edition: "quick", dryRun: false, testerId: TESTER_ID } });
  assert.equal(unconfirmed.statusCode, 400);
  const sent = await call(r.testSend, { method: "POST", body: { edition: "quick", dryRun: false, confirm: true, testerId: TESTER_ID } });
  assert.equal(sent.statusCode, 200, JSON.stringify(sent.body));
  assert.deepEqual(fakes.calls.sends[1], { recipientPsid: "", edition: "quick", dryRun: false, versionId: VERSION_LIVE, testerId: TESTER_ID }, "the raw PSID is resolved server-side, not passed by the route");
  const text = JSON.stringify(sent.body);
  assert.equal(text.includes(TESTER_PSID), false, "the raw PSID is masked even though the sender put it in the payload");
  assert.match(text, /Туршигч Миний утас/);
  assert.equal((sent.body.outcome as { metaMessageId: string }).metaMessageId, "m_test_1");
  assert.equal(fetchCalls, 0);
});

test("test-send to a tester is refused when it is unknown, revoked, outside the 24 h window or the kill switch is on", async () => {
  await useFakes(makeFakes({ testers: standardTesters() }));
  const r = await routes();
  const real = (testerId: string) => call(r.testSend, { method: "POST", body: { edition: "quick", dryRun: false, confirm: true, testerId } });
  const unknown = await real("99999999-9999-4999-8999-999999999999");
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.error, "tester_not_found");
  const revoked = await real(REVOKED_TESTER_ID);
  assert.equal(revoked.statusCode, 409);
  assert.equal(revoked.body.error, "tester_revoked");
  const closed = await real(CLOSED_TESTER_ID);
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.body.error, "tester_window_closed");
  assert.match(String(closed.body.message), /24 цагийн цонх/);
  assert.equal((await call(r.testSend, { method: "POST", body: { edition: "quick", testerId: "nope" } })).statusCode, 400);
  assert.equal((await call(r.testSend, { method: "POST", body: { edition: "quick", testerId: TESTER_ID, recipientRef: "0123456789abcdef" } })).statusCode, 400, "one way to name a recipient");
  assert.deepEqual(fakes.calls.sends, [], "nothing reached the sender");

  await useFakes(makeFakes({ testers: standardTesters(), metaDisabled: true }));
  const killed = await real(TESTER_ID);
  assert.equal(killed.statusCode, 409);
  assert.equal(killed.body.error, "meta_outbound_disabled");
  assert.deepEqual(fakes.calls.sends, []);
});

test("test-send: the preview sample goes only to a verified tester, never to an env recipient", async () => {
  await useFakes(makeFakes({ allowlist: [TEST_PSID], testers: standardTesters() }));
  const r = await routes();
  const { recipientRef } = await import("../src/lib/catalogue/admin/deps");
  const env = await call(r.testSend, { method: "POST", body: { versionId: VERSION_PREVIEW, dryRun: false, confirm: true, recipientRef: recipientRef(TEST_PSID) } });
  assert.equal(env.statusCode, 422);
  assert.equal(env.body.error, "preview_not_publishable");
  const tester = await call(r.testSend, { method: "POST", body: { versionId: VERSION_PREVIEW, dryRun: false, confirm: true, testerId: TESTER_ID } });
  assert.equal(tester.statusCode, 200, JSON.stringify(tester.body));
  assert.equal(tester.body.edition, "preview");
});

// ── Hero photo picker, display title and the recommended shortlist ───────────────────────────────

test("photos GET lists candidates with real size, score and issues, and the current choice", async () => {
  const r = await routes();
  const res = await call(r.photos, { query: { tripId: "test-trip-1" }, headers: adminBearerHeaders() });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const candidates = res.body.candidates as Array<{ url: string; width: number; score: number; issues: string[] }>;
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].width, 2400);
  assert.deepEqual(candidates[1].issues, ["нягтрал бага (640px)"]);
  assert.equal(res.body.chosen, null);
  assert.equal(res.body.titleOverride, null);
  assert.equal(res.body.title, "Жишиг-аялал test-trip-1");
  assert.equal((await call(r.photos, { query: { tripId: "not a trip!" } })).statusCode, 400);
  assert.equal((await call(r.photos, { query: { tripId: "ghost-trip" } })).statusCode, 404);
});

test("photos PUT stores the hero choice and title override in the catalogue config only", async () => {
  const r = await routes();
  const url = "https://img.example.test/hero-1.jpg";
  const res = await call(r.photos, { method: "PUT", body: { tripId: "test-trip-1", hero: { url, focal: { x: 0.3333333, y: 0.6 }, zoom: 1.5 }, titleOverride: "  Богино   гарчиг  " } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(fakes.calls.saved.length, 1);
  const saved = fakes.calls.saved[0].next;
  assert.deepEqual(saved.heroByTripId["test-trip-1"], { url, focal: { x: 0.333, y: 0.6 }, zoom: 1.5 });
  assert.equal(saved.titleOverrides["test-trip-1"], "Богино гарчиг");
  assert.deepEqual(Object.keys(saved).sort(), ["complete", "heroByTripId", "preview", "quick", "titleOverrides", "updatedAt", "updatedBy"], "nothing but curation is stored: no price, date or trip title");
  assert.match(String(fakes.calls.saved[0].actor), /@/);
  assert.deepEqual(res.body.chosen, { url, focal: { x: 0.333, y: 0.6 }, zoom: 1.5 });

  const again = await call(r.photos, { query: { tripId: "test-trip-1" } });
  assert.deepEqual(again.body.chosen, { url, focal: { x: 0.333, y: 0.6 }, zoom: 1.5 });
  assert.equal(again.body.titleOverride, "Богино гарчиг");

  const cleared = await call(r.photos, { method: "PUT", body: { tripId: "test-trip-1", hero: null, titleOverride: null } });
  assert.equal(cleared.statusCode, 200);
  const after = fakes.calls.saved[1].next;
  assert.deepEqual(after.heroByTripId, {});
  assert.deepEqual(after.titleOverrides, {});
});

test("photos PUT refuses a photo that is not one of the trip's candidates, bad crops and bad titles", async () => {
  const r = await routes();
  const url = "https://img.example.test/hero-1.jpg";
  const bad: Array<[number, unknown, string]> = [
    [422, { tripId: "test-trip-1", hero: { url: "https://evil.example.test/other.jpg" } }, "a photo of some other trip or site"],
    [400, { tripId: "test-trip-1", hero: { url: "http://img.example.test/hero-1.jpg" } }, "plain http"],
    [400, { tripId: "test-trip-1", hero: { url, focal: { x: 1.2, y: 0.5 } } }, "focal above 1"],
    [400, { tripId: "test-trip-1", hero: { url, focal: { x: -0.1, y: 0.5 } } }, "focal below 0"],
    [400, { tripId: "test-trip-1", hero: { url, focal: { x: "0.5", y: 0.5 } } }, "focal as text"],
    [400, { tripId: "test-trip-1", hero: { url, zoom: 0.9 } }, "zoom below 1"],
    [400, { tripId: "test-trip-1", hero: { url, zoom: 3.1 } }, "zoom above 3"],
    [400, { tripId: "test-trip-1", hero: { url, zoom: Number.NaN } }, "zoom NaN"],
    [400, { tripId: "test-trip-1", hero: { url, price: 1 } }, "unknown hero key"],
    [400, { tripId: "test-trip-1", titleOverride: "я".repeat(81) }, "title over 80"],
    [400, { tripId: "test-trip-1", titleOverride: 42 }, "title not text"],
    [400, { tripId: "test-trip-1" }, "nothing to change"],
    [400, { tripId: "test-trip-1", hero: null, price: 1 }, "price is not accepted"],
    [400, { tripId: "test-trip-1", hero: null, title: "Нэр" }, "the trip's own title is not accepted"],
    [404, { tripId: "ghost-trip", hero: null }, "unknown trip"],
  ];
  for (const [status, body, why] of bad) {
    const res = await call(r.photos, { method: "PUT", body });
    assert.equal(res.statusCode, status, why);
  }
  assert.equal(fakes.calls.saved.length, 0, "nothing was stored");
  const exactly80 = await call(r.photos, { method: "PUT", body: { tripId: "test-trip-1", titleOverride: "я".repeat(80) } });
  assert.equal(exactly80.statusCode, 200, "80 characters is fine");
});

test("photos PUT keeps the other editions' curation and other trips' choices, and passes the concurrency guard", async () => {
  const r = await routes();
  fakes.setConfig({
    quick: { tripIds: QUICK_EIGHT, groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    complete: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    preview: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    heroByTripId: { "test-trip-2": { url: "https://img.example.test/hero-2.jpg", focal: null, zoom: null } },
    titleOverrides: {},
    updatedAt: "2026-06-14T00:00:00.000Z",
    updatedBy: "someone@example.test",
  });
  const res = await call(r.photos, { method: "PUT", body: { tripId: "test-trip-1", hero: null, titleOverride: "Шинэ", expectedUpdatedAt: "2026-06-14T00:00:00.000Z" } });
  assert.equal(res.statusCode, 200);
  const next = fakes.calls.saved[0].next;
  assert.deepEqual(next.quick.tripIds, QUICK_EIGHT);
  assert.ok(next.heroByTripId["test-trip-2"], "another trip's choice survives");
  assert.deepEqual(fakes.calls.saved[0].opts, { expectedUpdatedAt: "2026-06-14T00:00:00.000Z" });
});

test("recommend returns the diverse shortlist with reasons and a cover, and saves nothing", async () => {
  const r = await routes();
  const res = await call(r.recommend, { headers: adminBearerHeaders() });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const body = res.body as unknown as { tripIds: string[]; reasons: Record<string, string>; cover: string };
  assert.equal(body.tripIds.length, 10);
  assert.equal(body.cover, body.tripIds[0]);
  assert.match(body.reasons[body.tripIds[0]], /Өөр чиглэл/);
  assert.equal(fakes.calls.saved.length, 0, "a suggestion is never auto-saved");
  assert.equal((await call(r.recommend, { method: "POST" })).statusCode, 405);
});

test("the review rows carry hero quality, a clear reason for weak heroes, and the staff overrides", async () => {
  const { buildReviewRows } = await import("../src/lib/catalogue/admin/review");
  const weak = { ...card("test-weak", 0), heroQuality: "weak" as const, photo: { url: "https://img.example.test/w.jpg", width: 640, height: 480, credit: null, source: "trip_photo" as const } };
  const missing = { ...card("test-missing", 1), heroQuality: "missing" as const, photo: null };
  const good = { ...card("test-good", 2), heroQuality: "excellent" as const };
  const review = buildReviewRows({
    edition: "quick",
    today: "2026-06-15",
    activeTrips: [trip("test-weak"), trip("test-missing"), trip("test-good")],
    snapshot: { edition: "complete", generatedAt: NOW.toISOString(), asOfDay: "2026-06-15", issueLabel: "x", seasonLabel: "x", trips: [weak, missing, good], coverTripId: "test-good", groups: [], contact: { phones: [], siteLabel: "", siteUrl: "" }, warnings: [], contentHash: "h" },
    eligibility: new Map([["test-weak", { eligible: true, reason: null }], ["test-missing", { eligible: true, reason: null }], ["test-good", { eligible: true, reason: null }]]),
    config: { tripIds: ["test-weak", "test-missing", "test-good"], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    codeMap: {},
    heroByTripId: { "test-good": { url: "https://img.example.test/g.jpg" } },
    titleOverrides: { "test-good": "Миний гарчиг" },
  });
  const by = (id: string) => review.rows.find((row) => row.tripId === id)!;
  assert.equal(by("test-weak").heroQuality, "weak");
  assert.match(by("test-weak").heroReason ?? "", /Хуучин эсвэл сул зураг \(640×480px\)/);
  assert.equal(by("test-missing").heroQuality, "missing");
  assert.match(by("test-missing").heroReason ?? "", /Зураг олдсонгүй/);
  assert.equal(by("test-good").heroReason, null);
  assert.equal(by("test-good").heroChosen, true);
  assert.equal(by("test-good").titleOverride, "Миний гарчиг");
  assert.equal(by("test-good").editorialTitle, "Жишиг test-good");
  assert.equal(by("test-weak").heroChosen, false);
});

// ── Readiness checklist ──────────────────────────────────────────────────────────────────────────

type ReadinessBody = { readiness: { overall: string; items: Array<{ id: string; status: string; label: string; detail: string; next: string | null }>; counts: Record<string, number | null> } };
const itemOf = (body: ReadinessBody, id: string) => body.readiness.items.find((item) => item.id === id)!;

test("state carries the readiness checklist: every item has a status, what was found and the next step; no id leaks", async () => {
  await useFakes(makeFakes({ allowlist: [TEST_PSID], liveDrift: true, testers: standardTesters() }));
  const r = await routes();
  const res = await call(r.state);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const body = res.body as unknown as ReadinessBody;
  const ids = body.readiness.items.map((item) => item.id);
  assert.deepEqual(ids, ["database", "renderer", "published_quick", "published_complete", "testers", "meta_switch", "heroes", "cover", "codes", "data_conflicts"]);
  for (const item of body.readiness.items) {
    assert.ok(["green", "amber", "red"].includes(item.status));
    assert.ok(item.detail.length > 0, `${item.id} says what it found`);
    if (item.status !== "green") assert.ok(item.next && item.next.length > 0, `${item.id} names the next step`);
  }
  assert.equal(itemOf(body, "database").status, "green");
  assert.equal(itemOf(body, "renderer").status, "green", "the repo's fonts and logo are on disk; nothing launched a browser");
  assert.equal(itemOf(body, "published_quick").status, "red", "a stale published file must be replaced");
  assert.match(itemOf(body, "published_quick").detail, /өөрчлөгдсөн/);
  assert.equal(itemOf(body, "published_complete").status, "amber", "nothing published yet");
  assert.equal(itemOf(body, "testers").status, "green", "a tester with an open window exists");
  assert.equal(itemOf(body, "meta_switch").status, "green");
  assert.equal(itemOf(body, "cover").status, "amber", "no cover chosen yet");
  assert.equal(body.readiness.overall, "red");
  assert.equal(body.readiness.counts.verifiedTesters, 2, "revoked testers are not counted");
  assert.equal(body.readiness.counts.openWindowTesters, 1);
  const json = JSON.stringify(res.body);
  assert.equal(json.includes(TESTER_PSID) || json.includes(TEST_PSID) || json.includes(PAIRING_CODE), false);
  assert.doesNotMatch(JSON.stringify(body.readiness), /PSID|kill switch|dry-run/i, "no technical vocabulary reaches the checklist");
});

test("state readiness: no tester asks to connect one, a closed window asks to write to the Page, the Meta switch is amber", async () => {
  const r = await routes();
  const none = (await call(r.state)).body as unknown as ReadinessBody;
  assert.equal(itemOf(none, "testers").status, "amber");
  assert.match(itemOf(none, "testers").next ?? "", /Тестер холбох/);

  await useFakes(makeFakes({ testers: [testerTarget({ id: CLOSED_TESTER_ID, psid: "70000000000557", lastInboundAt: new Date(NOW.getTime() - 30 * 3_600_000).toISOString() })], metaDisabled: true }));
  const closed = (await call(r.state)).body as unknown as ReadinessBody;
  assert.equal(itemOf(closed, "testers").status, "amber");
  assert.match(itemOf(closed, "testers").next ?? "", /дахин бичнэ үү/);
  assert.equal(itemOf(closed, "meta_switch").status, "amber");
  assert.match(itemOf(closed, "meta_switch").detail, /унтраалттай/);
});

test("state readiness: missing renderer files are red and named; a check that fails is amber, never green", async () => {
  const r = await routes();
  await useFakes(makeFakes());
  const { setCatalogueAdminDepsForTests } = await import("../src/lib/catalogue/admin/deps");
  fakes.deps.rendererAssetsMissing = async () => ["public/fonts/Missing-Face.ttf"];
  setCatalogueAdminDepsForTests(fakes.deps);
  const missing = (await call(r.state)).body as unknown as ReadinessBody;
  assert.equal(itemOf(missing, "renderer").status, "red");
  assert.match(itemOf(missing, "renderer").detail, /Missing-Face\.ttf/);
  fakes.deps.rendererAssetsMissing = async () => {
    throw new Error("disk error");
  };
  const broken = (await call(r.state)).body as unknown as ReadinessBody;
  assert.equal(itemOf(broken, "renderer").status, "amber");
});

test("readiness builder: heroes, codes and data conflicts are graded from the review rows", async () => {
  const { buildReadiness, tripFactsFromReview, worstStatus } = await import("../src/lib/catalogue/admin/readiness");
  const { buildReviewRows } = await import("../src/lib/catalogue/admin/review");
  const weak = { ...card("test-weak", 0, [{ code: "transport_conflict" as const, severity: "warning" as const, message: "x" }]), heroQuality: "weak" as const };
  const missing = { ...card("test-missing", 1, [{ code: "duration_conflict" as const, severity: "warning" as const, message: "y" }]), heroQuality: "missing" as const, photo: null };
  const good = { ...card("test-good", 2), heroQuality: "excellent" as const };
  const quickConfig = { tripIds: ["test-good"], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] };
  const elig = (id: string) => [id, { eligible: true, reason: null }] as const;
  const review = buildReviewRows({
    edition: "quick",
    today: "2026-06-15",
    activeTrips: [trip("test-weak"), trip("test-missing"), trip("test-good")],
    snapshot: { edition: "complete", generatedAt: NOW.toISOString(), asOfDay: "2026-06-15", issueLabel: "x", seasonLabel: "x", trips: [weak, missing, good], coverTripId: null, groups: [], contact: { phones: [], siteLabel: "", siteUrl: "" }, warnings: [], contentHash: "h" },
    eligibility: new Map([elig("test-weak"), elig("test-missing"), elig("test-good")]),
    config: quickConfig,
    codeMap: { "test-weak": "A01", "test-missing": "A02" },
  });
  const facts = tripFactsFromReview(review, quickConfig);
  assert.deepEqual(facts, { eligible: 3, heroWeak: 1, heroMissing: 1, quickHeroesFlagged: 0, codesAllocated: 3, transportConflicts: 1, durationConflicts: 1, priceConflicts: 0 });

  const none = { status: "none" as const, ageDays: null, reasons: [] as string[] };
  const base = {
    database: { ok: true },
    missingAssets: [] as string[] | null,
    editions: { quick: { published: null, latestDraft: null, freshness: none }, complete: { published: null, latestDraft: null, freshness: none } },
    testers: [],
    testersError: false,
    envRecipients: 0,
    metaOutboundDisabled: false,
    config: { heroByTripId: {}, coverPhoto: null },
  };
  // Flagged heroes in the Quick selection are red; elsewhere they are only amber.
  const redHeroes = buildReadiness({ ...base, trips: { ...facts, quickHeroesFlagged: 2 } });
  assert.equal(redHeroes.items.find((item) => item.id === "heroes")!.status, "red");
  const amberHeroes = buildReadiness({ ...base, trips: facts });
  assert.equal(amberHeroes.items.find((item) => item.id === "heroes")!.status, "amber");
  assert.equal(amberHeroes.items.find((item) => item.id === "data_conflicts")!.status, "amber", "title/program conflicts are looked at, not blocking");
  assert.match(amberHeroes.items.find((item) => item.id === "data_conflicts")!.detail, /тээвэр 1, хугацаа 1/);
  const priceRed = buildReadiness({ ...base, trips: { ...facts, priceConflicts: 1 } });
  assert.equal(priceRed.items.find((item) => item.id === "data_conflicts")!.status, "red");
  const allGood = buildReadiness({
    ...base,
    config: { heroByTripId: { a: { url: "https://x.test/a.jpg" } }, coverPhoto: { url: "https://x.test/c.jpg" } },
    trips: { eligible: 3, heroWeak: 0, heroMissing: 0, quickHeroesFlagged: 0, codesAllocated: 3, transportConflicts: 0, durationConflicts: 0, priceConflicts: 0 },
  });
  assert.equal(allGood.items.find((item) => item.id === "heroes")!.status, "green");
  assert.equal(allGood.items.find((item) => item.id === "cover")!.status, "green");
  assert.equal(allGood.items.find((item) => item.id === "codes")!.detail, "3/3 аялалд байнгын код олгосон. Хэвлэл бүрт ижил.");
  const unreadable = buildReadiness({ ...base, trips: null, missingAssets: null });
  assert.equal(unreadable.items.find((item) => item.id === "heroes")!.status, "amber", "an unreadable review is never reported as fine");
  assert.equal(unreadable.counts.eligibleTrips, null);
  const codesMissing = buildReadiness({ ...base, trips: { ...facts, codesAllocated: 1 } });
  assert.match(codesMissing.items.find((item) => item.id === "codes")!.detail, /1\/3/);
  assert.equal(worstStatus(["green", "amber"]), "amber");
  assert.equal(worstStatus([]), "green");
});

// ── Cover photo ──────────────────────────────────────────────────────────────────────────────────

import type { CataloguePhotoCandidate } from "../src/lib/catalogue/types";

function pooled(base: string, scores: number[]): CataloguePhotoCandidate[] {
  return scores.map((score, index) => ({ url: `https://img.example.test/${base}-${index}.jpg`, width: 2400, height: 1600, source: "trip_photo" as const, score, issues: [] as string[], credit: null }));
}

function useCoverPools(extra: Record<string, CataloguePhotoCandidate[]>) {
  const data = fakes.deps.data!;
  const original = data.listPhotoCandidates.bind(data);
  data.listPhotoCandidates = async (tripId: string) => {
    if (extra[tripId]) {
      fakes.calls.candidateQueries.push(tripId);
      return { trip: { id: tripId }, candidates: extra[tripId], chosen: null };
    }
    return original(tripId);
  };
}

test("cover candidates: only approved photos no page prints, a poster layout or a weak file never, the same picture once, best first", async () => {
  const r = await routes();
  const poster = { url: "https://img.example.test/poster-layout.jpg", width: 3000, height: 2000, source: "poster_hero" as const, score: 99, issues: [] as string[], credit: null };
  const weak = { url: "https://img.example.test/soft.jpg", width: 640, height: 480, source: "trip_photo" as const, score: 30, issues: ["нягтрал бага (640px)"], credit: null };
  const a = [...pooled("a", [92, 90, 85, 80, 70]), poster, weak];
  const b = pooled("b", [91, 89, 84, 78]);
  const c = [...pooled("c", [95, 94, 93]), a[3]!]; // the very same picture stored under a third trip, which prints c-0..2
  useCoverPools({ "test-trip-1": a, "test-trip-2": b, "test-trip-3": c });
  const res = await call(r.photos, { query: { cover: "1" }, headers: adminBearerHeaders() });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const body = res.body as unknown as { current: unknown; truncated: boolean; candidates: Array<{ url: string; tripId: string; score: number }> };
  const urls = body.candidates.map((candidate) => candidate.url);
  // test-trip-1 prints a-0 (hero) + a-1, a-2 (gallery); test-trip-2 prints b-0, b-1, b-2.
  assert.deepEqual(urls, ["https://img.example.test/a-3.jpg", "https://img.example.test/b-3.jpg", "https://img.example.test/a-4.jpg"], "unused, approved, de-duplicated, best score first");
  assert.equal(urls.includes(poster.url), false, "a poster layout is not a cover photograph");
  assert.equal(urls.includes(weak.url), false, "a soft file never opens the book");
  assert.equal(body.candidates[0]!.tripId, "test-trip-1");
  assert.equal(body.current, null);
  assert.equal(body.truncated, false);
  assert.equal(fakes.calls.saved.length, 0, "searching saves nothing");
  assert.ok(fakes.calls.candidateQueries.length <= 14, "the search is bounded to 14 trips");
});

test("cover candidates: a staff hero choice moves a photo onto its page, so it stops being offered as the cover", async () => {
  const r = await routes();
  useCoverPools({ "test-trip-1": pooled("a", [92, 90, 85, 80, 70]) });
  const chosen = "https://img.example.test/a-3.jpg";
  fakes.setConfig({ ...(await fakes.deps.store!.getCatalogueConfig()), heroByTripId: { "test-trip-1": { url: chosen } } });
  const res = await call(r.photos, { query: { cover: "1" }, headers: adminBearerHeaders() });
  const urls = (res.body.candidates as Array<{ url: string }>).map((candidate) => candidate.url);
  assert.equal(urls.includes(chosen), false, "now the hero of its page");
  assert.ok(urls.includes("https://img.example.test/a-2.jpg"), "and the photo that left the gallery is free again");
});

test("cover candidates: the bounded search stops at its time budget and says so", async () => {
  const { loadCoverPools, COVER_MAX_TRIPS } = await import("../src/lib/catalogue/admin/cover");
  let clock = 0;
  const result = await loadCoverPools({
    data: fakes.deps.data!,
    activeTrips: TRIP_IDS.map(trip),
    config: await fakes.deps.store!.getCatalogueConfig(),
    today: "2026-06-15",
    codes: {},
    now: () => (clock += 400),
    budgetMs: 1000,
  });
  assert.equal(result.truncated, true);
  assert.ok(result.searched < COVER_MAX_TRIPS, "stopped before covering every trip");
  assert.ok(result.searched >= 1);
});

test("config PUT saves the cover photo for one of the trip's own candidates and keeps everything else", async () => {
  const r = await routes();
  const url = "https://img.example.test/hero-1.jpg";
  fakes.setConfig({
    quick: { tripIds: QUICK_EIGHT, groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    complete: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    preview: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    heroByTripId: { "test-trip-2": { url: "https://img.example.test/hero-2.jpg" } },
    titleOverrides: { "test-trip-2": "Нэр" },
    updatedAt: "2026-06-14T00:00:00.000Z",
    updatedBy: "someone@example.test",
  });
  const res = await call(r.config, { method: "PUT", body: { coverPhoto: { url, tripId: "test-trip-1", focal: { x: 0.25, y: 0.6 }, zoom: 1.4 }, expectedUpdatedAt: "2026-06-14T00:00:00.000Z" } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const saved = fakes.calls.saved[0]!;
  assert.deepEqual(saved.next.coverPhoto, { url, focal: { x: 0.25, y: 0.6 }, zoom: 1.4 });
  assert.deepEqual(saved.next.quick.tripIds, QUICK_EIGHT, "the editions are untouched");
  assert.ok(saved.next.heroByTripId["test-trip-2"] && saved.next.titleOverrides["test-trip-2"], "hero choices and titles survive");
  assert.deepEqual(saved.opts, { expectedUpdatedAt: "2026-06-14T00:00:00.000Z" }, "the concurrency guard applies");

  const cleared = await call(r.config, { method: "PUT", body: { coverPhoto: null } });
  assert.equal(cleared.statusCode, 200);
  assert.equal(fakes.calls.saved[1]!.next.coverPhoto, null, "back to the automatic cover");
});

test("config PUT refuses a cover photo that is not the named trip's own, bad crops, unknown keys, and a read-only caller", async () => {
  const r = await routes();
  const url = "https://img.example.test/hero-1.jpg";
  const bad: Array<[number, unknown, string]> = [
    [422, { coverPhoto: { url: "https://evil.example.test/x.jpg", tripId: "test-trip-1" } }, "a photo of some other site"],
    [404, { coverPhoto: { url, tripId: "ghost-trip" } }, "unknown trip"],
    [400, { coverPhoto: { url, tripId: "test-trip-1", focal: { x: 2, y: 0 } } }, "focal out of range"],
    [400, { coverPhoto: { url, tripId: "test-trip-1", zoom: 9 } }, "zoom out of range"],
    [400, { coverPhoto: { url: "http://img.example.test/hero-1.jpg", tripId: "test-trip-1" } }, "plain http"],
    [400, { coverPhoto: { url } }, "no trip named"],
    [400, { coverPhoto: { url, tripId: "test-trip-1", price: 1 } }, "unknown key"],
    [400, { coverPhoto: null, edition: "quick" }, "a cover body carries no edition"],
    [400, { coverPhoto: "x" }, "not an object"],
  ];
  for (const [status, body, why] of bad) {
    assert.equal((await call(r.config, { method: "PUT", body })).statusCode, status, why);
  }
  assert.equal(fakes.calls.saved.length, 0, "nothing was stored");
  const readOnly = await call(r.config, { method: "PUT", body: { coverPhoto: null }, headers: adminBearerHeaders() });
  assert.ok([401, 403].includes(readOnly.statusCode), "the read-only token cannot write");
  assert.equal(fakes.calls.saved.length, 0);
});

test("version trips: the codes a version printed come from its own snapshot, never recomputed", async () => {
  const route = (await import("../src/pages/api/admin/catalogue/version/[id]/trips")).default as Handler;
  const res = await call(route, { query: { id: VERSION_LIVE }, headers: adminBearerHeaders() });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const trips = res.body.trips as Array<{ code: string; tripId: string; title: string }>;
  assert.deepEqual(trips.slice(0, 3).map((entry) => entry.code), ["A01", "A02", "A03"]);
  assert.equal(trips[0]!.tripId, "test-trip-1");
  assert.equal((await call(route, { query: { id: "bad id!" } })).statusCode, 400);
  assert.equal((await call(route, { query: { id: "99999999-9999-4999-8999-999999999999" } })).statusCode, 404);
  assert.equal(fakes.calls.loadInput.length, 0, "nothing was loaded or allocated");
});
