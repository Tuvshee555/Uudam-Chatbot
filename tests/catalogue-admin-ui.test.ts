import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CatalogueConfig, CatalogueVersionMeta } from "../src/lib/catalogue/types";
import type {
  CatalogueAdminState,
  CatalogueCoverCandidatesResponse,
  CatalogueReadiness,
  CatalogueReviewResponse,
  CatalogueReviewRow,
  CatalogueTesterView,
  CatalogueVersionView,
} from "../src/lib/catalogue/admin/types";
import type { CatalogueAdmin } from "../src/components/admin/catalogue/useCatalogueAdmin";

// Server-rendered smoke tests of the catalogue admin screens with invented data: they prove the
// panels render the facts staff must see (file, size, freshness, price + date + source, warnings),
// that unsafe controls are disabled, and that every control has an accessible name.

const quickIds = Array.from({ length: 8 }, (_, i) => `test-trip-${i + 1}`);

function view(overrides: Partial<CatalogueVersionMeta> & { id: string }): CatalogueVersionView {
  const meta: CatalogueVersionMeta = {
    edition: "quick",
    versionNo: 3,
    fileName: "UUDAM_Test_2026-06-15_v3.pdf",
    status: "published",
    sizeBytes: 2_621_440,
    pageCount: 14,
    sha256: "0".repeat(64),
    contentHash: "1".repeat(64),
    tripCount: 10,
    generatedAt: "2026-06-14T01:00:00.000Z",
    generatedBy: "owner.test@example.test",
    publishedAt: "2026-06-14T02:00:00.000Z",
    publishedBy: "owner.test@example.test",
    publicToken: "tok_abcdefghijklmnopqrstuvwxyz",
    warnings: [],
    ...overrides,
  };
  const base = `/api/admin/catalogue/version/${meta.id}`;
  return {
    ...meta,
    downloadPath: `${base}/pdf`,
    openPath: `${base}/pdf?disposition=inline`,
    pagePath: `${base}/page`,
    publicPath: meta.status === "published" ? `/api/catalogue/file/${meta.publicToken}` : null,
    blockingCount: meta.warnings.filter((w) => w.severity === "blocking").length,
    warningCount: meta.warnings.filter((w) => w.severity === "warning").length,
  };
}

const config: CatalogueConfig = {
  quick: { tripIds: quickIds.slice(0, 3), groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
  complete: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
  preview: { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] },
  heroByTripId: {},
  titleOverrides: {},
  updatedAt: "2026-06-14T00:00:00.000Z",
  updatedBy: "owner.test@example.test",
};

function adminState(overrides: Partial<CatalogueAdminState> = {}): CatalogueAdminState {
  return {
    ok: true,
    serverTime: "2026-06-15T05:00:00.000Z",
    today: "2026-06-15",
    limits: { quickMin: 8, quickMax: 12, previewMin: 1, previewMax: 4, staleAfterDays: 21 },
    editions: {
      quick: { published: view({ id: "q1" }), latestDraft: null, freshness: { status: "fresh", ageDays: 1, reasons: [] } },
      complete: { published: null, latestDraft: null, freshness: { status: "none", ageDays: null, reasons: [] } },
    },
    testSend: {
      testers: [], recipients: [], metaOutboundDisabled: false, realSendPossible: false, testersError: null, pairingCodeTtlMinutes: 30,
      blockedReason: "Баталгаажсан туршигч алга. Нэг удаа: «Тестер холбох» дарж гарсан кодыг өөрийн Messenger-ээс манай Page руу бичнэ үү.",
    },
    config: structuredClone(config),
    readiness: readinessFixture(),
    ...overrides,
  };
}

function readinessFixture(overrides: Partial<CatalogueReadiness> = {}): CatalogueReadiness {
  return {
    overall: "amber",
    items: [
      { id: "database", status: "green", label: "Өгөгдлийн сан", detail: "Холбогдсон, каталогийн хүснэгтүүд бэлэн.", next: null },
      { id: "testers", status: "amber", label: "Баталгаажсан тестер", detail: "Тестер холбоогүй байна.", next: "«Тестер холбох» дарна уу." },
      { id: "heroes", status: "red", label: "Аяллын гол зураг", detail: "2 аяллын зураг сул.", next: "«Зураг ба гарчиг» хэсэгт сонгоно уу." },
    ],
    counts: {
      eligibleTrips: 10, verifiedTesters: 0, openWindowTesters: 0, heroesConfigured: 1, heroesWeak: 2, heroesMissing: 0, quickHeroesFlagged: 2,
      codesAllocated: 10, transportConflicts: 0, durationConflicts: 0, priceConflicts: 0, staleEditions: 0,
    },
    ...overrides,
  };
}

/** The first <button> whose visible text is exactly `label` (class names also contain "disabled:", so test the attribute). */
function buttonWithText(html: string, label: string): string | undefined {
  return (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).find((tag) => tag.replace(/<[^>]*>/g, "").trim() === label);
}

const isDisabled = (tag: string | undefined) => Boolean(tag && /\sdisabled=""/.test(tag.slice(0, tag.indexOf(">") + 1)));

function row(overrides: Partial<CatalogueReviewRow> & { tripId: string }): CatalogueReviewRow {
  return {
    code: "A01",
    title: `Жишиг-аялал ${overrides.tripId}`,
    groupKey: "rest",
    groupLabel: "Амралт",
    durationText: "5 өдөр",
    transportLabel: "Газрын аялал",
    eligible: true,
    eligibilityReason: null,
    priceDisplay: "3,980,000₮-с",
    priceAmountMnt: 3_980_000,
    priceDate: "2026-09-01",
    priceSource: "dated_fare",
    priceSourceLabel: "Огнооны үнийн хүснэгт (2026-09-01)",
    nextDeparture: "2026-09-01",
    departureCount: 3,
    dateLabel: "2026.09.01-ний хөдлөлт",
    photo: { url: "https://img.example.test/a.jpg", source: "poster_hero", width: 1600, height: 1000 },
    photoSourceLabel: "Постерын гол зураг",
    heroQuality: "good",
    heroReason: null,
    heroChosen: false,
    editorialTitle: null,
    titleOverride: null,
    warnings: [],
    severity: "ok",
    selected: true,
    position: 1,
    featured: false,
    excluded: false,
    groupOverride: null,
    ...overrides,
  };
}

function review(rows: CatalogueReviewRow[]): CatalogueReviewResponse {
  return {
    ok: true,
    edition: "quick",
    today: "2026-06-15",
    rows,
    groups: [{ key: "rest", label: "Амралт" }],
    counts: { active: rows.length, eligible: rows.filter((r) => r.eligible).length, blocking: rows.filter((r) => r.severity === "blocking").length, warning: rows.filter((r) => r.severity === "warning").length },
  };
}

function fakeAdmin(overrides: Partial<CatalogueAdmin> = {}): CatalogueAdmin {
  const never = async () => {
    throw new Error("the API must not be called while rendering");
  };
  return {
    api: new Proxy({}, { get: () => never }) as CatalogueAdmin["api"],
    state: adminState(),
    versions: [view({ id: "q1" }), view({ id: "q0", versionNo: 2, status: "superseded", publishedAt: "2026-06-01T00:00:00.000Z" })],
    reviews: {},
    loading: false,
    error: null,
    reviewLoading: null,
    reviewError: null,
    reload: async () => undefined,
    loadReview: async () => undefined,
    ...overrides,
  };
}

async function render<P extends object>(load: () => Promise<{ [key: string]: unknown }>, name: string, props: P): Promise<string> {
  const { ToastProvider } = await import("../src/components/ui");
  const component = (await load())[name] as ComponentType<P>;
  const element: ReactElement = createElement(ToastProvider, null, createElement(component, props));
  return renderToStaticMarkup(element);
}

test("versions panel shows file facts, download links and the stale reasons", async () => {
  const stale = adminState();
  stale.editions.quick.freshness = { status: "stale", ageDays: 30, reasons: ["Каталог 30 хоногийн настай (21 хоногоос хэтэрсэн)"] };
  const html = await render(() => import("../src/components/admin/catalogue/VersionsPanel"), "VersionsPanel", {
    admin: fakeAdmin({ state: stale }),
    onPreview: () => undefined,
    onGenerate: () => undefined,
  });
  assert.match(html, /UUDAM_Test_2026-06-15_v3\.pdf/);
  assert.match(html, /2\.5 MB/);
  assert.match(html, /Энэ хувилбар хуучирсан/);
  assert.match(html, /30 хоногийн настай/);
  assert.match(html, /href="\/api\/admin\/catalogue\/version\/q1\/pdf"[^>]*download=/, "a real download link");
  assert.match(html, /target="_blank"[^>]*rel="noopener noreferrer"|rel="noopener noreferrer"[^>]*target="_blank"/);
  assert.match(html, /Нийтлэгдсэн хувилбар алга/, "the unpublished edition says so");
  assert.match(html, /aria-label="v2 руу буцах"/, "history offers a rollback only for a superseded version");
  assert.doesNotMatch(html, /aria-label="v3 руу буцах"/);
});

test("review panel prints the exact price, date, source and every warning", async () => {
  const conflict = row({
    tripId: "test-dalai",
    severity: "blocking",
    warnings: [{ code: "price_conflict", severity: "blocking", message: "Тайлбарт 3,880,000₮, огнооны үнэ 3,980,000₮" }],
  });
  const noPhoto = row({ tripId: "test-hodoo", code: "A02", photo: null, photoSourceLabel: "Зураггүй: орлуулагч хэрэглэнэ", severity: "warning", warnings: [{ code: "photo_missing", severity: "warning", message: "Зураг алга" }] });
  const html = await render(() => import("../src/components/admin/catalogue/ReviewPanel"), "ReviewPanel", {
    admin: fakeAdmin({ reviews: { quick: review([conflict, noPhoto]) } }),
  });
  assert.match(html, /3,980,000₮-с/);
  assert.match(html, /Огнооны үнийн хүснэгт \(2026-09-01\)/);
  assert.match(html, /Тайлбарт 3,880,000₮, огнооны үнэ 3,980,000₮/);
  assert.match(html, /Хориглосон/);
  assert.match(html, /Зураг алга/);
  assert.match(html, /<img[^>]*src="https:\/\/img\.example\.test\/a\.jpg"/, "the image source is shown as a thumbnail");
  assert.match(html, /<caption class="sr-only">/, "the table has an accessible caption");
});

test("test-send panel: with no tester there is ONE prominent connect button, the send is closed and the step is named in plain words", async () => {
  const html = await render(() => import("../src/components/admin/catalogue/TestSendPanel"), "TestSendPanel", { admin: fakeAdmin() });
  assert.doesNotMatch(html, /CATALOGUE_TEST_RECIPIENT_PSIDS|Vercel|PSID|dry-run|kill switch/i, "no ids to hunt for, no variables to edit, no jargon");
  assert.match(html, /Эхлээд «Тестер холбох» товчийг дарж өөрийн Messenger-ээ холбоно уу/);
  const connect = buttonWithText(html, "Тестер холбох");
  assert.ok(connect, "the pairing control is always there");
  assert.equal(isDisabled(connect), false);
  assert.match(connect ?? "", /h-11/, "it is the large button");
  const real = buttonWithText(html, "Тест илгээх");
  assert.ok(real, "the single send control exists");
  assert.equal(isDisabled(real), true, "and is closed until a tester is connected");
  const preview = buttonWithText(html, "Дээж харах (илгээхгүй)");
  assert.ok(preview, "the preview of what would be sent is one click away");
  assert.equal(isDisabled(preview), false, "and works without a tester");
  assert.doesNotMatch(html, /<input type="checkbox"/, "no arming checkbox: one button, then a confirmation dialog");
});

test("test-send panel: with an env recipient the one send button opens and the recipient stays masked", async () => {
  const state = adminState({
    testSend: { testers: [], recipients: [{ ref: "0123456789abcdef", label: "…0001" }], metaOutboundDisabled: false, realSendPossible: true, blockedReason: null, testersError: null, pairingCodeTtlMinutes: 30 },
  });
  const html = await render(() => import("../src/components/admin/catalogue/TestSendPanel"), "TestSendPanel", { admin: fakeAdmin({ state }) });
  assert.doesNotMatch(html, /70000000000001/);
  assert.equal(isDisabled(buttonWithText(html, "Тест илгээх")), false, "a reachable recipient opens the send button");
});

test("pairing code card: a big copyable code, the three plain steps, a countdown and a new-code control", async () => {
  const html = await render(() => import("../src/components/admin/catalogue/TesterPairing"), "PairingCodeCard", {
    code: "UUDAM-TEST-ABC234", remaining: 29 * 60_000 + 41_000, onCopy: () => undefined, onNewCode: () => undefined, onCancel: () => undefined, busy: false,
  });
  assert.match(html, /<code[^>]*font-mono[^>]*text-3xl[^>]*>UUDAM-TEST-ABC234<\/code>/, "big monospaced code");
  assert.ok(buttonWithText(html, "Хуулах"), "Copy button");
  assert.match(html, /<ol[^>]*>\s*<li>Messenger-ээ нээгээд манай Page руу орно<\/li><li>Энэ кодыг яг хэвээр нь бичиж илгээнэ<\/li><li>Энд автоматаар «Холбогдлоо» гарна<\/li>/);
  assert.match(html, /29:41/, "countdown");
  assert.ok(buttonWithText(html, "Шинэ код"), "one-click new code");
  assert.doesNotMatch(html, /PSID/i);
});

test("page preview exposes working navigation, a width choice and labelled images", async () => {
  const html = await render(() => import("../src/components/admin/catalogue/PagePreview"), "PagePreview", { version: view({ id: "q1" }) });
  assert.match(html, /src="\/api\/admin\/catalogue\/version\/q1\/page\/1"/);
  assert.match(html, /aria-label="Өмнөх хуудас"[^>]*disabled|disabled[^>]*aria-label="Өмнөх хуудас"/, "no previous page from page 1");
  assert.match(html, /aria-label="Дараагийн хуудас"/);
  assert.match(html, /type="range"[^>]*min="1"[^>]*max="14"/);
  assert.match(html, /Утасны өргөн/);
  assert.equal((html.match(/aria-label="\d+-р хуудас"/g) ?? []).length, 14, "one thumbnail button per page");
});

test("generate flow warns when the Quick selection is out of bounds and disables Generate", async () => {
  const html = await render(() => import("../src/components/admin/catalogue/GenerateFlow"), "GenerateFlow", {
    admin: fakeAdmin(),
    focusVersionId: null,
    onPublished: () => undefined,
  });
  assert.match(html, /8–12 аялал сонгоно \(одоо 3\)/);
  assert.equal(isDisabled(buttonWithText(html, "Үүсгэх")), true, "Generate is disabled while the selection is invalid");
  assert.match(html, /aria-current="step"/);
});

test("generate flow with a valid Quick selection enables Generate and names the shared snapshot", async () => {
  const state = adminState();
  state.config.quick.tripIds = quickIds;
  const html = await render(() => import("../src/components/admin/catalogue/GenerateFlow"), "GenerateFlow", {
    admin: fakeAdmin({ state }),
    focusVersionId: null,
    onPublished: () => undefined,
  });
  assert.doesNotMatch(html, /8–12 аялал сонгоно/);
  assert.equal(isDisabled(buttonWithText(html, "Үүсгэх")), false);
  assert.match(html, /Үүсгэх үед шалгагдана/, "the renderer is checked when generating, not on every page load");
});

test("curation panel shows the counter against the Quick limits and a candidate list", async () => {
  const rows = quickIds.map((id, i) => row({ tripId: id, code: `A0${i + 1}`, position: i < 3 ? i + 1 : null, selected: i < 3 }));
  const html = await render(() => import("../src/components/admin/catalogue/CurationPanel"), "CurationPanel", {
    admin: fakeAdmin({ reviews: { quick: review(rows) } }),
  });
  assert.match(html, /3 \/ 8–12 аялал сонгосон/);
  assert.match(html, /Дахин 5 аялал нэмнэ үү/);
  assert.match(html, /aria-label="Жишиг-аялал test-trip-1: дээш зөөх"/);
  assert.match(html, /aria-label="Жишиг-аялал test-trip-4: нэмэх"/);
  assert.match(html, /aria-pressed="false"/, "feature is a toggle button");
  assert.equal(isDisabled(buttonWithText(html, "Хадгалах")), true, "nothing to save yet");
  assert.equal(isDisabled(buttonWithText(html, "Жишиг-аялал test-trip-4: нэмэх")), false, "a candidate can be added");
});

test("the whole tab opens in its loading state and stays in the light theme", async () => {
  const { CatalogueTab } = await import("../src/components/admin/CatalogueTab");
  const { ToastProvider } = await import("../src/components/ui");
  // Server render shows the loading state; the tablist appears once data exists, which the panels above cover.
  const html = renderToStaticMarkup(createElement(ToastProvider, null, createElement(CatalogueTab, { apiFetch: async () => new Response("{}") })));
  assert.match(html, /Аяллын каталог/);
  assert.match(html, /Мэдээлэл ачаалж байна/);
  assert.doesNotMatch(html, /dark:/, "the admin stays in the light theme");
});

// ── Verified testers ─────────────────────────────────────────────────────────────────────────────

const openTester: CatalogueTesterView = { id: "11111111-1111-4111-8111-111111111111", label: "Миний утас", masked: "…0555", verifiedAt: "2026-06-14T01:00:00.000Z", lastInboundAt: "2026-06-15T04:00:00.000Z", windowOpen: true, windowClosesAt: "2026-06-16T03:55:00.000Z" };
const closedTester: CatalogueTesterView = { id: "33333333-3333-4333-8333-333333333333", label: "", masked: "…0557", verifiedAt: "2026-06-10T01:00:00.000Z", lastInboundAt: "2026-06-12T04:00:00.000Z", windowOpen: false, windowClosesAt: null };

function stateWithTesters(testers: CatalogueTesterView[]): CatalogueAdminState {
  const open = testers.some((tester) => tester.windowOpen);
  return adminState({
    testSend: {
      testers, recipients: [], metaOutboundDisabled: false, realSendPossible: open, testersError: null, pairingCodeTtlMinutes: 30,
      blockedReason: open ? null : "Бүх туршигчийн Messenger-ийн 24 цагийн цонх хаагдсан байна.",
    },
  });
}

test("test-send panel lists verified testers masked, with the live Messenger window and a revoke control", async () => {
  const html = await render(() => import("../src/components/admin/catalogue/TestSendPanel"), "TestSendPanel", { admin: fakeAdmin({ state: stateWithTesters([openTester, closedTester]) }) });
  assert.match(html, /Холбогдсон тестерүүд/);
  assert.match(html, /Миний утас/);
  assert.match(html, /…0555/);
  assert.match(html, /Messenger цонх нээлттэй/);
  assert.match(html, /Messenger цонх хаагдсан/);
  assert.match(html, /aria-label="Миний утас: эрхийг цуцлах"/);
  assert.match(html, /aria-label="Миний Messenger: эрхийг цуцлах"/);
  assert.doesNotMatch(html, /70000000000555|70000000000557/, "no PSID in the page");
  assert.match(html, /<option[^>]*value="tester:11111111-1111-4111-8111-111111111111"[^>]*>Миний утас …0555<\/option>/, "the open tester is selectable");
  assert.match(html, /<option[^>]*disabled=""[^>]*>[^<]*…0557 \(цонх хаагдсан\)<\/option>|<option[^>]*value="tester:33333333[^"]*"[^>]*disabled=""/, "a closed window cannot be chosen");
  assert.equal(isDisabled(buttonWithText(html, "Тест илгээх")), false, "an open window opens the single send button");
  assert.ok(buttonWithText(html, "Өөр Messenger холбох"), "connecting another device stays available");
});

test("test-send panel: when every tester's window is closed the send is closed and the person is told to write to the Page again", async () => {
  const html = await render(() => import("../src/components/admin/catalogue/TestSendPanel"), "TestSendPanel", { admin: fakeAdmin({ state: stateWithTesters([closedTester]) }) });
  assert.match(html, /Messenger цонх хаагдсан/);
  assert.match(html, /та манай Page руу дахин бичнэ үү/);
  assert.equal(isDisabled(buttonWithText(html, "Тест илгээх")), true);
  assert.equal(isDisabled(buttonWithText(html, "Дээж харах (илгээхгүй)")), false, "the preview needs no window");
});

test("test-send panel: with the Meta switch off the person is told, in plain words, that only the preview works", async () => {
  const state = adminState({
    testSend: { testers: [openTester], recipients: [], metaOutboundDisabled: true, realSendPossible: false, blockedReason: "Meta руу илгээх түр унтраалттай байна.", testersError: null, pairingCodeTtlMinutes: 30 },
  });
  const html = await render(() => import("../src/components/admin/catalogue/TestSendPanel"), "TestSendPanel", { admin: fakeAdmin({ state }) });
  assert.match(html, /Meta руу илгээх түр унтраалттай байна/);
  assert.equal(isDisabled(buttonWithText(html, "Тест илгээх")), true);
  assert.equal(isDisabled(buttonWithText(html, "Дээж харах (илгээхгүй)")), false);
});

test("readiness panel: every item is green / amber / red with what was found and the one next step; open when not all green", async () => {
  const html = await render(() => import("../src/components/admin/catalogue/ReadinessPanel"), "ReadinessPanel", { readiness: readinessFixture() });
  assert.match(html, /<details open=""/, "open while something needs attention");
  assert.match(html, /Нийтлэхээс өмнөх шалгалт/);
  assert.match(html, /data-status="green"/);
  assert.match(html, /data-status="amber"/);
  assert.match(html, /data-status="red"/);
  assert.match(html, /→ «Зураг ба гарчиг» хэсэгт сонгоно уу\./, "the next step is a plain sentence");
  const allGreen = await render(() => import("../src/components/admin/catalogue/ReadinessPanel"), "ReadinessPanel", {
    readiness: readinessFixture({ overall: "green", items: [{ id: "database", status: "green", label: "Өгөгдлийн сан", detail: "Холбогдсон.", next: null }] }),
  });
  assert.doesNotMatch(allGreen, /<details open=""/, "folds into one line when everything is fine");
  assert.match(allGreen, /Нийтлэхэд бэлэн/);
});

test("review panel: transport and duration conflicts get a plain chip and a one-line explanation", async () => {
  const rows = [
    row({
      tripId: "test-conflict",
      warnings: [
        { code: "transport_conflict", severity: "warning", message: "Гарчигт дамжин нислэг, бүртгэлд шууд нислэг" },
        { code: "duration_conflict", severity: "warning", message: "Гарчигт 5 өдөр, бүртгэлд 6 өдөр" },
      ],
      severity: "warning",
    }),
  ];
  const html = await render(() => import("../src/components/admin/catalogue/ReviewPanel"), "ReviewPanel", { admin: fakeAdmin({ reviews: { quick: review(rows) } }) });
  assert.match(html, /Тээвэр зөрсөн/);
  assert.match(html, /Хугацаа зөрсөн/);
  assert.match(html, /аялал засварлагч дээр шалгана уу/);
  assert.match(html, /Гарчигт дамжин нислэг, бүртгэлд шууд нислэг/, "the specific finding is kept");
});

test("cover photo chooser: candidates with trip code, focal and zoom controls, a 9:16 preview, and no save until changed", async () => {
  const data: CatalogueCoverCandidatesResponse = {
    ok: true,
    current: null,
    truncated: false,
    searchedTrips: 6,
    candidates: [
      { url: "https://img.example.test/cover-1.jpg", width: 2600, height: 1700, source: "trip_photo", score: 91, issues: [], credit: null, tripId: "test-trip-9", code: "A09", tripTitle: "Жишиг-аялал 9" },
      { url: "https://img.example.test/cover-2.jpg", width: 2000, height: 1300, source: "trip_photo", score: 66, issues: [], credit: null, tripId: "test-trip-3", code: null, tripTitle: "Жишиг-аялал 3" },
    ],
  };
  const { CoverPhotoForm } = await import("../src/components/admin/catalogue/CoverPhotoChooser");
  const idle = await render(async () => ({ CoverPhotoForm }), "CoverPhotoForm", { data, draft: null, onDraft: () => undefined, saving: false, onSave: () => undefined, onAutomatic: () => undefined });
  assert.match(idle, /A09 · Жишиг-аялал 9/, "the persistent code is shown");
  assert.match(idle, /Автомат нүүр зураг ашиглаж байна/);
  assert.equal(isDisabled(buttonWithText(idle, "Нүүр зургийг хадгалах")), true, "nothing to save yet");
  assert.equal(isDisabled(buttonWithText(idle, "Автомат руу буцаах")), true, "already automatic");
  const picked = await render(async () => ({ CoverPhotoForm }), "CoverPhotoForm", {
    data, draft: { url: data.candidates[0]!.url, tripId: "test-trip-9", focal: { x: 0.4, y: 0.3 }, zoom: 1.5 }, onDraft: () => undefined, saving: false, onSave: () => undefined, onAutomatic: () => undefined,
  });
  assert.match(picked, /Нүүр хуудсанд \(9:16\)/, "page-shaped preview");
  assert.match(picked, /type="range"[^>]*min="1"[^>]*max="3"/, "zoom slider");
  assert.equal(isDisabled(buttonWithText(picked, "Нүүр зургийг хадгалах")), false);
});

test("cover chooser helpers: the stored cover maps back to its trip, and dirty checks compare the crop", async () => {
  const { draftOfCover, coverChanged } = await import("../src/components/admin/catalogue/CoverPhotoChooser");
  const candidate = { url: "https://img.example.test/c.jpg", width: 2000, height: 1300, source: "trip_photo" as const, score: 80, issues: [], credit: null, tripId: "test-trip-9", code: "A09", tripTitle: "T" };
  assert.equal(draftOfCover({ url: "https://img.example.test/other.jpg" }, [candidate]), null, "a cover whose photo left the pool has no known trip");
  const draft = draftOfCover({ url: candidate.url, focal: { x: 0.2, y: 0.7 }, zoom: 2 }, [candidate]);
  assert.deepEqual(draft, { url: candidate.url, tripId: "test-trip-9", focal: { x: 0.2, y: 0.7 }, zoom: 2 });
  assert.equal(coverChanged(draft, { url: candidate.url, focal: { x: 0.2, y: 0.7 }, zoom: 2 }), false);
  assert.equal(coverChanged({ ...draft!, zoom: 2.3 }, { url: candidate.url, focal: { x: 0.2, y: 0.7 }, zoom: 2 }), true);
  assert.equal(coverChanged(draft, null), true, "choosing when nothing is stored is a change");
  assert.equal(coverChanged(null, null), false);
});

// ── Photo picker ─────────────────────────────────────────────────────────────────────────────────

test("photos panel lists weak and missing heroes first with a clear reason and a way to replace them", async () => {
  const rows = [
    row({ tripId: "test-weak", code: "A01", heroQuality: "weak", heroReason: "Хуучин эсвэл сул зураг (640×480px): нүүрэнд хэвлэхэд нягтрал, чанар хүрэлцэхгүй тул солих шаардлагатай." }),
    row({ tripId: "test-missing", code: "A02", photo: null, heroQuality: "missing", heroReason: "Зураг олдсонгүй: өөр зураг сонгох эсвэл аяллын зураг нэмэх шаардлагатай." }),
    row({ tripId: "test-good", code: "A03", heroQuality: "excellent", heroChosen: true, editorialTitle: "Богино нэр", titleOverride: "Миний гарчиг" }),
  ];
  const html = await render(() => import("../src/components/admin/catalogue/PhotosPanel"), "PhotosPanel", { admin: fakeAdmin({ reviews: { quick: review(rows) } }) });
  assert.match(html, /Хуучин\/сул зураг — солих шаардлагатай \(2\)/);
  assert.match(html, /нүүрэнд хэвлэхэд нягтрал, чанар хүрэлцэхгүй/);
  assert.match(html, /Зураг олдсонгүй: өөр зураг сонгох/);
  assert.match(html, /aria-label="Жишиг-аялал test-weak: зураг солих"/);
  assert.match(html, /Сул зураг/);
  assert.match(html, /Зураггүй/);
  assert.match(html, /Маш сайн зураг/);
  assert.match(html, /Гараар сонгосон/);
  assert.match(html, /Миний гарчиг/, "the staff display title is what the list shows");
  assert.match(html, /Аялал сонгоно уу/, "nothing is open until a trip is picked");
  assert.doesNotMatch(html, /dark:/);
});

test("photos panel with only good heroes shows no replacement list", async () => {
  const html = await render(() => import("../src/components/admin/catalogue/PhotosPanel"), "PhotosPanel", { admin: fakeAdmin({ reviews: { quick: review([row({ tripId: "test-good" })]) } }) });
  assert.doesNotMatch(html, /солих шаардлагатай \(/);
});

test("the hero picker form shows each candidate's real size, score and issues, a 9:16 preview, sliders and a title input capped at 80", async () => {
  const data = {
    ok: true as const, tripId: "test-trip-1", title: "Жишиг-аялал", titleOverride: "Миний гарчиг", chosen: null,
    candidates: [
      { url: "https://img.example.test/hero-1.jpg", width: 2400, height: 1600, source: "poster_hero" as const, score: 88.4, issues: [], credit: null },
      { url: "https://img.example.test/hero-2.jpg", width: 640, height: 480, source: "trip_photo" as const, score: 31, issues: ["нягтрал бага (640px)"], credit: "Тест зураглаач" },
    ],
  };
  const html = await render(() => import("../src/components/admin/catalogue/HeroEditor"), "HeroEditorForm", {
    tripId: "test-trip-1", data, draft: { url: data.candidates[0].url, focal: { x: 0.25, y: 0.75 }, zoom: 1.5, title: "Миний гарчиг" },
    onDraft: () => undefined, saving: false, dirty: false, titleTooLong: false, onSave: () => undefined, onClear: () => undefined, onReset: () => undefined,
  });
  assert.match(html, /2400×1600px/);
  assert.match(html, /640×480px/);
  assert.match(html, /Оноо 88/);
  assert.match(html, /нягтрал бага \(640px\)/);
  assert.match(html, /Тест зураглаач/);
  assert.equal((html.match(/type="radio"/g) ?? []).length, 2, "one real radio per candidate");
  assert.match(html, /<input type="radio"[^>]*aria-label="Зураг, 2400×1600px, оноо 88"[^>]*checked=""/, "the current hero is the checked one");
  assert.match(html, /aspect-ratio:\s*9\s*\/\s*16/, "a 9:16 preview");
  assert.match(html, /object-position:\s*25\.0% 75\.0%/, "the preview crops with the same CSS the render uses");
  assert.match(html, /transform:\s*scale\(1\.5\)/);
  assert.match(html, /data-testid="focal-frame"/);
  assert.equal((html.match(/type="range"/g) ?? []).length, 3, "x, y and zoom are real keyboard-operable sliders");
  assert.match(html, /type="range"[^>]*min="1"[^>]*max="3"|min="1"[^>]*max="3"[^>]*type="range"/);
  assert.match(html, /Хэвлэгдэх гарчиг/);
  assert.match(html, /value="Миний гарчиг"/);
  assert.equal(isDisabled(buttonWithText(html, "Хадгалах")), true, "nothing to save yet");
  assert.equal(isDisabled(buttonWithText(html, "Автомат руу буцаах")), true, "no stored choice to undo");
});

test("hero picker helpers: pointer to focal point, CSS crop, dirty checks", async () => {
  const crop = await import("../src/components/admin/catalogue/heroCrop");
  const rect = { left: 100, top: 50, width: 200, height: 100 };
  assert.deepEqual(crop.focalFromPointer(rect, 200, 100), { x: 0.5, y: 0.5 });
  assert.deepEqual(crop.focalFromPointer(rect, 0, 1000), { x: 0, y: 1 }, "clamped inside the photo");
  assert.deepEqual(crop.focalFromPointer({ ...rect, width: 0 }, 5, 5), crop.FOCAL_CENTER, "a collapsed frame falls back to the centre");
  const style = crop.cropStyle({ x: 0.2, y: 0.9 }, 2);
  assert.equal(style.objectPosition, "20.0% 90.0%");
  assert.equal(style.transform, "scale(2)");
  assert.equal(crop.cropStyle(null, 1).transform, undefined, "no zoom, no transform");
  assert.equal(crop.cropStyle({ x: 0.5, y: 0.5 }, 9).transform, "scale(3)", "zoom is capped at 3");

  const stored = { url: "https://img.example.test/a.jpg", focal: { x: 0.4, y: 0.4 }, zoom: 1.2 };
  const same = crop.draftOf(stored, "Гарчиг", null);
  assert.equal(crop.heroChanged(same, stored), false);
  assert.equal(crop.heroChanged({ ...same, zoom: 1.5 }, stored), true);
  assert.equal(crop.heroChanged({ ...same, focal: { x: 0.41, y: 0.4 } }, stored), true);
  const automatic = crop.draftOf(null, null, "https://img.example.test/first.jpg");
  assert.equal(crop.heroChanged(automatic, null, "https://img.example.test/first.jpg"), false, "the automatic first candidate is not a change");
  assert.equal(crop.heroChanged({ ...automatic, url: "https://img.example.test/other.jpg" }, null, "https://img.example.test/first.jpg"), true);
  assert.equal(crop.titleChanged(same, "Гарчиг"), false);
  assert.equal(crop.titleChanged({ ...same, title: "  Гарчиг  " }, "Гарчиг"), false);
  assert.equal(crop.titleChanged({ ...same, title: "" }, "Гарчиг"), true);
  assert.equal(crop.needsNewPhoto("weak"), true);
  assert.equal(crop.needsNewPhoto("missing"), true);
  assert.equal(crop.needsNewPhoto("good"), false);
});

test("review panel shows the hero quality chip, the reason and the staff display title", async () => {
  const flagged = row({ tripId: "test-weak", heroQuality: "weak", heroReason: "Хуучин эсвэл сул зураг: солих шаардлагатай.", heroChosen: true, editorialTitle: "Автомат нэр", titleOverride: "Миний гарчиг" });
  const html = await render(() => import("../src/components/admin/catalogue/ReviewPanel"), "ReviewPanel", { admin: fakeAdmin({ reviews: { quick: review([flagged]) } }) });
  assert.match(html, /Сул зураг/);
  assert.match(html, /Хуучин эсвэл сул зураг: солих шаардлагатай\./);
  assert.match(html, /гараар сонгосон/);
  assert.match(html, /Хэвлэгдэх гарчиг: Миний гарчиг \(гараар\)/);
});

test("curation panel offers the recommended shortlist for Quick without selecting it for you", async () => {
  const rows = quickIds.map((id, i) => row({ tripId: id, code: `A0${i + 1}`, position: i < 3 ? i + 1 : null, selected: i < 3 }));
  const html = await render(() => import("../src/components/admin/catalogue/CurationPanel"), "CurationPanel", { admin: fakeAdmin({ reviews: { quick: review(rows) } }) });
  const recommend = buttonWithText(html, "Санал болгосон 10-г ашиглах");
  assert.ok(recommend, "the control exists");
  assert.equal(isDisabled(recommend), false);
  assert.match(html, /3 \/ 8–12 аялал сонгосон/, "rendering it changes nothing");
  assert.equal(isDisabled(buttonWithText(html, "Хадгалах")), true, "and nothing is saved");
});

// ── Tester set-up state machine (pure) ───────────────────────────────────────────────────────────

test("pairing flow: a poll that sees a new tester pairs and selects it; polling stops; late or stray events change nothing", async () => {
  const flow = await import("../src/components/admin/catalogue/pairingFlow");
  const T0 = Date.parse("2026-06-15T05:00:00.000Z");
  const response = { code: "UUDAM-TEST-ABC234", expiresAt: new Date(T0 + 30 * 60_000).toISOString(), ttlMinutes: 30 };

  let state = flow.reducePairing(flow.initialPairing, { type: "request", testers: [openTester] });
  assert.equal(state.phase, "issuing");
  assert.equal(flow.shouldPoll(state, false), false, "no polling before a code exists");
  assert.equal(flow.reducePairing(flow.initialPairing, { type: "issued", response, nowMs: T0 }).phase, "idle", "an answer nobody asked for is ignored");

  state = flow.reducePairing(state, { type: "issued", response, nowMs: T0 });
  assert.equal(state.phase, "waiting");
  assert.equal(flow.shouldPoll(state, false), true);
  assert.equal(flow.shouldPoll(state, true), false, "paused while the tab is hidden");
  assert.equal(flow.formatCountdown(flow.remainingMs(state, T0 + 59_000)), "29:01");
  assert.equal(flow.formatCountdown(0), "0:00");

  state = flow.reducePairing(state, { type: "polled", testers: [openTester], nowMs: T0 + 3000 });
  assert.equal(state.phase, "waiting", "the tester that was already there is not a new pairing");
  const fresh: CatalogueTesterView = { ...closedTester, id: "44444444-4444-4444-8444-444444444444", verifiedAt: new Date(T0 + 5000).toISOString(), windowOpen: true };
  state = flow.reducePairing(state, { type: "polled", testers: [openTester, fresh], nowMs: T0 + 6000 });
  assert.deepEqual([state.phase, state.testerId], ["paired", fresh.id]);
  assert.equal(flow.shouldPoll(state, false), false, "stops on success");
  assert.equal(flow.reducePairing(state, { type: "tick", nowMs: T0 + 31 * 60_000 }).phase, "paired", "a later expiry cannot undo a pairing");
  assert.equal(flow.reducePairing(state, { type: "polled", testers: [], nowMs: T0 + 9000 }).phase, "paired");
});

test("pairing flow: the countdown expires the code, a failed request is an error, reset starts over", async () => {
  const flow = await import("../src/components/admin/catalogue/pairingFlow");
  const T0 = Date.parse("2026-06-15T05:00:00.000Z");
  const response = { code: "UUDAM-TEST-ABC234", expiresAt: new Date(T0 + 30 * 60_000).toISOString(), ttlMinutes: 30 };
  let state = flow.reducePairing(flow.initialPairing, { type: "request", testers: [] });
  state = flow.reducePairing(state, { type: "issued", response, nowMs: T0 });
  assert.equal(flow.reducePairing(state, { type: "tick", nowMs: T0 + 29 * 60_000 }).phase, "waiting");
  const expired = flow.reducePairing(state, { type: "tick", nowMs: T0 + 30 * 60_000 });
  assert.equal(expired.phase, "expired");
  assert.equal(flow.shouldPoll(expired, false), false, "stops on expiry");
  assert.equal(flow.reducePairing(state, { type: "polled", testers: [], nowMs: T0 + 31 * 60_000 }).phase, "expired", "a poll after the deadline also notices");
  const failed = flow.reducePairing(flow.reducePairing(flow.initialPairing, { type: "request", testers: [] }), { type: "failed", message: "Хэт олон хүсэлт" });
  assert.deepEqual([failed.phase, failed.error], ["error", "Хэт олон хүсэлт"]);
  assert.equal(flow.reducePairing(failed, { type: "reset" }), flow.initialPairing);
  // The same device paired again: no new id, but its message arrived after the code was minted.
  const again = flow.reducePairing(flow.reducePairing(flow.initialPairing, { type: "request", testers: [openTester] }), { type: "issued", response, nowMs: T0 });
  const rewrote: CatalogueTesterView = { ...openTester, lastInboundAt: new Date(T0 + 4000).toISOString() };
  assert.equal(flow.reducePairing(again, { type: "polled", testers: [rewrote], nowMs: T0 + 5000 }).testerId, openTester.id);
});

test("send readiness: ready, no tester, window closed, revoked and Meta off each have their own plain sentence", async () => {
  const { testReadiness, TEST_READINESS_TEXT } = await import("../src/components/admin/catalogue/pairingFlow");
  assert.deepEqual(testReadiness({ testers: [openTester], selectedId: null, metaOutboundDisabled: false }), { kind: "ready", testerId: openTester.id });
  assert.deepEqual(testReadiness({ testers: [closedTester, openTester], selectedId: closedTester.id, metaOutboundDisabled: false }), { kind: "window_closed", testerId: closedTester.id });
  assert.deepEqual(testReadiness({ testers: [], selectedId: null, metaOutboundDisabled: false }), { kind: "no_tester" });
  assert.deepEqual(testReadiness({ testers: [openTester], selectedId: closedTester.id, metaOutboundDisabled: false }), { kind: "revoked" });
  assert.deepEqual(testReadiness({ testers: [openTester], selectedId: openTester.id, metaOutboundDisabled: true }), { kind: "meta_off" });
  assert.match(TEST_READINESS_TEXT.window_closed, /Page руу дахин бичнэ үү/);
  assert.match(TEST_READINESS_TEXT.revoked, /цуцлагдсан/);
  for (const text of Object.values(TEST_READINESS_TEXT)) assert.doesNotMatch(text, /PSID|kill switch|dry-run/i);
});
