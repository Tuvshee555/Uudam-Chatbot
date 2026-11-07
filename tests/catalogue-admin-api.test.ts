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

// Invented data only: no real trip, place, price or date appears in this file.
const NOW = new Date("2026-06-15T05:00:00.000Z");
const TEST_PSID = "70000000000001";
const OTHER_PSID = "70000000000099";

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

function makeFakes(options: { allowlist?: string[]; metaDisabled?: boolean; renderFails?: boolean; liveDrift?: boolean } = {}) {
  const calls = {
    schema: 0,
    loadInput: [] as Array<{ edition: CatalogueEdition; opts: unknown }>,
    render: 0,
    drafts: [] as Array<{ edition: CatalogueEdition; snapshot: CatalogueSnapshot; actor: string | null }>,
    saved: [] as Array<{ next: CatalogueConfig; actor: string | null; opts: unknown }>,
    published: [] as Array<{ id: string; actor: string | null; acknowledgeWarnings: boolean }>,
    rolledBack: [] as string[],
    sends: [] as Array<{ recipientPsid: string; edition: CatalogueEdition; dryRun: boolean; versionId: string | null }>,
  };
  let config: CatalogueConfig = {
    quick: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    complete: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
    preview: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
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
        calls.sends.push({ recipientPsid: input.recipientPsid, edition: input.edition, dryRun, versionId: input.versionId ?? null });
        const version = versions.get(input.versionId ?? "") ?? versions.get(VERSION_LIVE)!;
        const recipientId = input.recipientPsid || "<test recipient>";
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
  const [state, config, trips, generate, versions, publish, rollback, testSend, stats, pdf, page] = await Promise.all([
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

test("test-send can dry-run a draft before it is published, but not history or the sample", async () => {
  const r = await routes();
  const draft = await call(r.testSend, { method: "POST", body: { versionId: VERSION_DRAFT } });
  assert.equal(draft.statusCode, 200, JSON.stringify(draft.body));
  assert.equal(draft.body.versionId, VERSION_DRAFT);
  assert.deepEqual(fakes.calls.sends, [{ recipientPsid: "", edition: "quick", dryRun: true, versionId: VERSION_DRAFT }]);
  assert.equal((await call(r.testSend, { method: "POST", body: { versionId: VERSION_OLD } })).statusCode, 409);
  assert.equal((await call(r.testSend, { method: "POST", body: { versionId: VERSION_PREVIEW } })).statusCode, 422);
  assert.equal((await call(r.testSend, { method: "POST", body: { versionId: VERSION_DRAFT, edition: "complete" } })).statusCode, 400);
  assert.equal((await call(r.testSend, { method: "POST", body: { versionId: "../x" } })).statusCode, 400);
  assert.equal((await call(r.testSend, { method: "POST", body: { versionId: "99999999-9999-4999-8999-999999999999" } })).statusCode, 404);
  assert.equal(fakes.calls.sends.length, 1, "refused requests never reached the sender");
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
  assert.match(body.testSend.blockedReason, /CATALOGUE_TEST_RECIPIENT_PSIDS/);
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
