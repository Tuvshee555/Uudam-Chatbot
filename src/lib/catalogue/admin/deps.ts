/**
 * The catalogue admin API's only doors to the rest of the feature.
 *
 * The admin routes never import store / data / render / send directly. They ask `getDeps()`,
 * which loads the real modules lazily (so a route that fails auth or validation never pays for
 * Chromium or the database) and which tests replace with in-memory fakes via
 * `setCatalogueAdminDepsForTests`. The port types below are the contract this module needs from
 * its siblings; the lazy loaders assign the real modules to them, so a drift in a sibling's
 * exported signature shows up as a typecheck error here.
 */

import { createHash } from "crypto";
import type { TravelTrip } from "../../travelTypes";
import type { CatalogueTestResult } from "../send";
import type {
  CatalogueConfig,
  CatalogueEdition,
  CatalogueSnapshot,
  CatalogueVersionMeta,
  IsoDay,
  RenderedCatalogue,
  SnapshotInput,
} from "../types";
import type { CatalogueStatsResponse } from "./types";
import { parsePsidAllowlist } from "./validation";

export type CatalogueStorePort = {
  ensureCatalogueSchema(): Promise<unknown>;
  getCatalogueConfig(): Promise<CatalogueConfig>;
  saveCatalogueConfig(
    next: CatalogueConfig,
    actor: string | null,
    options?: { expectedUpdatedAt?: string | null },
  ): Promise<CatalogueConfig>;
  saveDraftVersion(input: {
    edition: CatalogueEdition;
    snapshot: CatalogueSnapshot;
    rendered: RenderedCatalogue;
    actor: string | null;
  }): Promise<CatalogueVersionMeta>;
  listVersions(edition?: CatalogueEdition, limit?: number): Promise<CatalogueVersionMeta[]>;
  getVersionMeta(id: string): Promise<CatalogueVersionMeta | null>;
  getVersionPdf(id: string): Promise<{ bytes: Buffer; meta: CatalogueVersionMeta } | null>;
  getVersionPageImage(id: string, page: number): Promise<Buffer | null>;
  getVersionSnapshot(id: string): Promise<CatalogueSnapshot | null>;
  publishVersion(
    id: string,
    actor: string | null,
    options: { acknowledgeWarnings: boolean },
  ): Promise<CatalogueVersionMeta>;
  rollbackTo(id: string, actor: string | null): Promise<CatalogueVersionMeta>;
  getPublished(edition: CatalogueEdition): Promise<CatalogueVersionMeta | null>;
  deliveryStats(days: number): Promise<Omit<CatalogueStatsResponse, "ok">>;
};

export type CatalogueDataPort = {
  loadSnapshotInput(
    edition: CatalogueEdition,
    options?: { nowIso?: string; tripIdsOverride?: string[]; readOnlyCodes?: boolean },
  ): Promise<SnapshotInput>;
  buildCatalogueSnapshot(input: SnapshotInput): CatalogueSnapshot;
  isTripEligible(trip: TravelTrip, today: IsoDay): { eligible: boolean; reason: string | null };
  liveDrift(published: CatalogueSnapshot, live: CatalogueSnapshot): { drifted: boolean; reasons: string[] };
};

export type CatalogueRenderPort = {
  renderCatalogue(snapshot: CatalogueSnapshot, options?: { pageImages?: boolean; versionLabel?: string }): Promise<RenderedCatalogue>;
};

export type CatalogueSendPort = {
  sendCatalogueTest(input: {
    recipientPsid: string;
    edition: CatalogueEdition;
    dryRun?: boolean;
    /** Test this exact version (a draft awaiting review) instead of the published one. */
    versionId?: string | null;
  }): Promise<CatalogueTestResult>;
};

export type CatalogueAdminDeps = {
  store: CatalogueStorePort;
  data: CatalogueDataPort;
  render: CatalogueRenderPort;
  send: CatalogueSendPort;
  /** Every trip in status "active", straight from the chatbot's trip store. */
  listActiveTrips(): Promise<TravelTrip[]>;
  /** Env allowlist of test PSIDs (CATALOGUE_TEST_RECIPIENT_PSIDS); empty when unset. */
  testRecipientPsids(): string[];
  /** The Meta kill switch / Vercel-preview suppression (metaOutboundKillSwitch.ts). */
  metaOutboundDisabled(): boolean;
  now(): Date;
};

let override: Partial<CatalogueAdminDeps> | null = null;

/** Tests only: replace any dependency. Pass null to restore the real ones. */
export function setCatalogueAdminDepsForTests(next: Partial<CatalogueAdminDeps> | null): void {
  override = next;
}

async function loadStore(): Promise<CatalogueStorePort> {
  const store: CatalogueStorePort = await import("../store");
  return store;
}

async function loadData(): Promise<CatalogueDataPort> {
  const data: CatalogueDataPort = await import("../tripData");
  return data;
}

async function loadRender(): Promise<CatalogueRenderPort> {
  const render: CatalogueRenderPort = await import("../render");
  return render;
}

async function loadSend(): Promise<CatalogueSendPort> {
  const send: CatalogueSendPort = await import("../send");
  return send;
}

async function listActiveTripsFromStore(): Promise<TravelTrip[]> {
  const { listTrips } = await import("../../travelOps");
  return listTrips({ status: "active", limit: 5000 });
}

/**
 * Lazy, per-key resolution: only the dependency a route actually touches is imported.
 * Each getter is memoised, so one request never imports twice.
 */
export type LazyDeps = {
  store(): Promise<CatalogueStorePort>;
  data(): Promise<CatalogueDataPort>;
  render(): Promise<CatalogueRenderPort>;
  send(): Promise<CatalogueSendPort>;
  listActiveTrips(): Promise<TravelTrip[]>;
  testRecipientPsids(): string[];
  metaOutboundDisabled(): Promise<boolean>;
  now(): Date;
};

function once<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => (cached ??= factory());
}

export function getDeps(): LazyDeps {
  const o = override;
  return {
    store: o?.store ? async () => o.store as CatalogueStorePort : once(loadStore),
    data: o?.data ? async () => o.data as CatalogueDataPort : once(loadData),
    render: o?.render ? async () => o.render as CatalogueRenderPort : once(loadRender),
    send: o?.send ? async () => o.send as CatalogueSendPort : once(loadSend),
    listActiveTrips: o?.listActiveTrips ?? listActiveTripsFromStore,
    testRecipientPsids: o?.testRecipientPsids ?? (() => parsePsidAllowlist(process.env.CATALOGUE_TEST_RECIPIENT_PSIDS)),
    metaOutboundDisabled: o?.metaOutboundDisabled
      ? async () => (o.metaOutboundDisabled as () => boolean)()
      : async () => (await import("../../metaOutboundKillSwitch")).isMetaOutboundDisabled(),
    now: o?.now ?? (() => new Date()),
  };
}

/** Opaque, stable reference for a PSID: the browser can pick a recipient without ever holding the id. */
export function recipientRef(psid: string): string {
  return createHash("sha256").update(`catalogue-test-recipient:${psid}`).digest("hex").slice(0, 16);
}

export function recipientLabel(psid: string): string {
  return `…${psid.slice(-4)}`;
}
