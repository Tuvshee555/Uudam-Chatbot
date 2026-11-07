/**
 * Wire types between the catalogue admin API (src/pages/api/admin/catalogue/*) and the admin UI
 * (src/components/admin/CatalogueTab.tsx). Type-only: safe to import from client code.
 *
 * Nothing here stores a trip title, price or date: the review rows are computed live on every
 * request from the chatbot's own trip store and are never written back.
 */

import type {
  CatalogueConfig,
  CatalogueEdition,
  CatalogueVersionMeta,
  CatalogueWarningCode,
  CatalogueWarningSeverity,
  IsoDay,
} from "../types";

/** Editions staff can generate. "preview" is the admin-selected 2-trip sample. */
export const ADMIN_EDITIONS: readonly CatalogueEdition[] = ["quick", "complete", "preview"];
/** The two editions that are ever published to customers. */
export const PUBLISHABLE_EDITIONS: readonly CatalogueEdition[] = ["quick", "complete"];
/** The preview sample holds a handful of trips, never a full catalogue. */
export const CATALOGUE_PREVIEW_MIN_TRIPS = 1;
export const CATALOGUE_PREVIEW_MAX_TRIPS = 4;

export type CatalogueVersionView = CatalogueVersionMeta & {
  /** Admin-only streaming routes. */
  downloadPath: string;
  openPath: string;
  pagePath: string;
  /** Token-addressed public file, present only while the version is the published one. */
  publicPath: string | null;
  blockingCount: number;
  warningCount: number;
};

export type CatalogueFreshnessView = {
  status: "fresh" | "stale" | "unknown" | "none";
  ageDays: number | null;
  reasons: string[];
};

export type CatalogueEditionState = {
  published: CatalogueVersionView | null;
  latestDraft: CatalogueVersionView | null;
  freshness: CatalogueFreshnessView;
};

export type CatalogueTestRecipient = {
  /** Opaque reference the UI sends back; the PSID itself never reaches the browser. */
  ref: string;
  /** "…4567" */
  label: string;
};

export type CatalogueAdminState = {
  ok: true;
  serverTime: string;
  today: IsoDay;
  limits: {
    quickMin: number;
    quickMax: number;
    previewMin: number;
    previewMax: number;
    staleAfterDays: number;
  };
  editions: { quick: CatalogueEditionState; complete: CatalogueEditionState };
  testSend: {
    recipients: CatalogueTestRecipient[];
    metaOutboundDisabled: boolean;
    /** True only when a real send could actually leave (allowlist set, kill switch off). */
    realSendPossible: boolean;
    blockedReason: string | null;
  };
  config: CatalogueConfig;
};

export type CatalogueReviewWarning = {
  code: CatalogueWarningCode;
  severity: CatalogueWarningSeverity;
  message: string;
};

export type CatalogueReviewRow = {
  tripId: string;
  code: string | null;
  /** Read live from the trip store on this request. */
  title: string;
  groupKey: string | null;
  groupLabel: string | null;
  durationText: string;
  transportLabel: string | null;
  eligible: boolean;
  /** Mongolian reason a trip is not part of the catalogue (eligible=false) or null. */
  eligibilityReason: string | null;
  priceDisplay: string | null;
  priceAmountMnt: number | null;
  /** The departure the price belongs to. */
  priceDate: IsoDay | null;
  priceSource: "dated_fare" | "trip_price" | "none";
  priceSourceLabel: string;
  nextDeparture: IsoDay | null;
  departureCount: number;
  dateLabel: string | null;
  photo: { url: string; source: string; width: number | null; height: number | null } | null;
  photoSourceLabel: string;
  warnings: CatalogueReviewWarning[];
  severity: "blocking" | "warning" | "info" | "ok";
  /** Curation state for the requested edition. */
  selected: boolean;
  position: number | null;
  featured: boolean;
  excluded: boolean;
  groupOverride: string | null;
};

export type CatalogueReviewResponse = {
  ok: true;
  edition: CatalogueEdition;
  today: IsoDay;
  rows: CatalogueReviewRow[];
  groups: Array<{ key: string; label: string }>;
  counts: { active: number; eligible: number; blocking: number; warning: number };
};

/** Aggregate delivery counts for the last N days. Counts only: no sender id, name or message text. */
export type CatalogueStatsResponse = {
  ok: true;
  days: number;
  since: string;
  until: string;
  totals: {
    attempts: number;
    sent: number;
    linkFallback: number;
    staleFallback: number;
    failed: number;
    blocked: number;
    noPublishedVersion: number;
    dryRun: number;
    inFlight: number;
    suppressedDuplicates: number;
  };
  byVersion: Array<{
    versionId: string | null;
    edition: string;
    versionNo: number | null;
    fileName: string | null;
    attempts: number;
    delivered: number;
    failed: number;
  }>;
  byDay: Array<{ day: string; attempts: number; delivered: number; failed: number }>;
  byStatus: Record<string, number>;
  uniqueRecipients: number;
  successRate: number | null;
  lastSentAt: string | null;
};

export type CatalogueTestSendResponse = {
  ok: true;
  dryRun: boolean;
  edition: CatalogueEdition;
  versionId: string | null;
  versionNo: number | null;
  fileName: string | null;
  /** What the delivery module reported ("dry_run" when nothing was sent). */
  outcome: { status: string; reason: string | null; fileAccepted: boolean; metaMessageId: string | null };
  /** The exact Messenger requests a real send makes: one text and one file attachment, in send order. */
  payload: {
    recipient: string;
    messages: Array<{ kind: "text" | "file"; body: Record<string, unknown> }>;
    file: { name: string; sizeBytes: number; pages: number | null; versionNo: number };
    attachmentSource: "cached_attachment_id" | "upload_on_send";
    publicUrl: string;
    fallbackText: string;
  } | null;
};
