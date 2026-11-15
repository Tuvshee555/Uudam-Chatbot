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
  CatalogueHeroChoice,
  CataloguePhotoCandidate,
  CataloguePhotoQuality,
  CatalogueVersionMeta,
  CatalogueWarningCode,
  CatalogueWarningSeverity,
  IsoDay,
} from "../types";
import type { CatalogueTesterView } from "../testers";

export type { CatalogueTesterView } from "../testers";

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
    /** Verified testers (paired with a one-time code): label, masked tail, window state. Never a PSID. */
    testers: CatalogueTesterView[];
    /** Optional extra recipients from the CATALOGUE_TEST_RECIPIENT_PSIDS environment variable. */
    recipients: CatalogueTestRecipient[];
    metaOutboundDisabled: boolean;
    /** True only when a real send could actually leave (a recipient with an open window, kill switch off). */
    realSendPossible: boolean;
    /** Mongolian: why a real send is closed, including the one live-device step still needed. */
    blockedReason: string | null;
    /** Set when the tester list itself could not be read. */
    testersError: string | null;
    pairingCodeTtlMinutes: number;
  };
  config: CatalogueConfig;
  /** The "before publishing" checklist: every item green / amber / red with a one-line Mongolian next step. */
  readiness: CatalogueReadiness;
};

export type CatalogueReadinessStatus = "green" | "amber" | "red";

export type CatalogueReadinessId =
  | "database"
  | "renderer"
  | "published_quick"
  | "published_complete"
  | "testers"
  | "meta_switch"
  | "heroes"
  | "cover"
  | "codes"
  | "data_conflicts";

export type CatalogueReadinessItem = {
  id: CatalogueReadinessId;
  status: CatalogueReadinessStatus;
  /** Short Mongolian name of the check. */
  label: string;
  /** One line: what was found. */
  detail: string;
  /** One line: what to do next; null when nothing is needed. */
  next: string | null;
};

/** Counts behind the checklist, so the UI and the docs can quote them. All are read live; none is stored. */
export type CatalogueReadinessCounts = {
  eligibleTrips: number | null;
  verifiedTesters: number;
  openWindowTesters: number;
  heroesConfigured: number;
  heroesWeak: number;
  heroesMissing: number;
  /** Weak or missing heroes among the trips the Quick edition would print. */
  quickHeroesFlagged: number;
  codesAllocated: number | null;
  transportConflicts: number;
  durationConflicts: number;
  priceConflicts: number;
  staleEditions: number;
};

export type CatalogueReadiness = {
  /** The worst item. "red" = something must be fixed before publishing. */
  overall: CatalogueReadinessStatus;
  items: CatalogueReadinessItem[];
  counts: CatalogueReadinessCounts;
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
  /** How good the hero is for a premium book. */
  heroQuality: CataloguePhotoQuality;
  /** Mongolian reason a weak / missing hero must be replaced, else null. */
  heroReason: string | null;
  /** Staff chose this hero (photo picker), so the automatic choice is not used. */
  heroChosen: boolean;
  /** Concise display title the book prints, and the staff override behind it, if any. */
  editorialTitle: string | null;
  titleOverride: string | null;
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
  /** The verified tester the send was addressed to (masked); null for a dry run with no tester or an env recipient. */
  tester: { id: string; label: string; masked: string; windowOpen: boolean; windowClosesAt: string | null } | null;
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

export type CatalogueTestersResponse = { ok: true; testers: CatalogueTesterView[] };

/** The one-time pairing code. It is shown once, in the browser of the staff member who asked for it. */
export type CataloguePairingResponse = {
  ok: true;
  code: string;
  expiresAt: string;
  ttlMinutes: number;
  /** Mongolian: what to do with the code. */
  instruction: string;
};

/** Photo picker data for one trip: every candidate with its real size, the current choice and title override. */
export type CataloguePhotosResponse = {
  ok: true;
  tripId: string;
  title: string | null;
  candidates: CataloguePhotoCandidate[];
  /** The staff choice stored in the catalogue config, or null when the automatic hero is used. */
  chosen: CatalogueHeroChoice | null;
  titleOverride: string | null;
};

/** One approved, unused photograph that could open the book. Not tied to a page: it belongs to a trip's pool only. */
export type CatalogueCoverCandidate = CataloguePhotoCandidate & {
  tripId: string;
  /** Persistent trip code, or null when the trip has none yet. */
  code: string | null;
  tripTitle: string;
};

export type CatalogueCoverCandidatesResponse = {
  ok: true;
  /** The staff cover choice stored in the catalogue config, or null (automatic). */
  current: CatalogueHeroChoice | null;
  candidates: CatalogueCoverCandidate[];
  /** True when the bounded search stopped early (time budget or trip cap): there may be more photos. */
  truncated: boolean;
  searchedTrips: number;
};

/** Trips printed in one stored version, with the persistent code each one carries. */
export type CatalogueVersionTripsResponse = {
  ok: true;
  versionId: string;
  trips: Array<{ code: string; tripId: string; title: string }>;
};

export type CatalogueRecommendResponse = {
  ok: true;
  tripIds: string[];
  /** Mongolian reason per recommended trip id. */
  reasons: Record<string, string>;
  cover: string | null;
};
