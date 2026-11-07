import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentType, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CatalogueConfig, CatalogueVersionMeta } from "../src/lib/catalogue/types";
import type {
  CatalogueAdminState,
  CatalogueReviewResponse,
  CatalogueReviewRow,
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
    testSend: { recipients: [], metaOutboundDisabled: false, realSendPossible: false, blockedReason: "CATALOGUE_TEST_RECIPIENT_PSIDS тохируулаагүй тул жинхэнэ туршилтын илгээлт хаалттай." },
    config: structuredClone(config),
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

test("test-send panel: with no allowlist the real send is disabled and the reason is shown", async () => {
  const html = await render(() => import("../src/components/admin/catalogue/TestSendPanel"), "TestSendPanel", { admin: fakeAdmin() });
  assert.match(html, /CATALOGUE_TEST_RECIPIENT_PSIDS/);
  assert.match(html, /Дээж \(dry-run\)/);
  const real = buttonWithText(html, "Туршилтаар илгээх");
  assert.ok(real, "the real-send control exists");
  assert.equal(isDisabled(real), true, "and is disabled");
  assert.match(html, /<input type="checkbox"[^>]*\sdisabled=""/, "the arming checkbox is disabled too");
  const dry = buttonWithText(html, "Дээж харах");
  assert.ok(dry, "the dry-run control exists");
  assert.equal(isDisabled(dry), false, "the dry-run stays available");
});

test("test-send panel: with a recipient the real send still needs the explicit checkbox", async () => {
  const state = adminState({
    testSend: { recipients: [{ ref: "0123456789abcdef", label: "…0001" }], metaOutboundDisabled: false, realSendPossible: true, blockedReason: null },
  });
  const html = await render(() => import("../src/components/admin/catalogue/TestSendPanel"), "TestSendPanel", { admin: fakeAdmin({ state }) });
  assert.match(html, /Туршигч …0001/);
  assert.doesNotMatch(html, /70000000000001/);
  assert.equal(isDisabled(buttonWithText(html, "Туршилтаар илгээх")), true, "unchecked checkbox keeps the send disabled");
  assert.doesNotMatch(html, /<input type="checkbox"[^>]*\sdisabled=""/, "the arming checkbox is usable once a recipient exists");
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
