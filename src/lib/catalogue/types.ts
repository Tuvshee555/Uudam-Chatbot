/**
 * Shared contract for the corporate travel catalogue ("Хамт олны аяллын сонголт").
 *
 * One pipeline, three stages, each owned by one folder:
 *
 *   tripData.ts   live trips (the chatbot's canonical store) --> CatalogueSnapshot   (pure + loader)
 *   render/       CatalogueSnapshot --> RenderedCatalogue (vector PDF + page images)
 *   store.ts      versions, publish pointer, trip codes, config, send log            (Neon)
 *   send.ts       published version --> ONE Messenger file attachment + ONE text
 *
 * Every module codes against the types below. Change a type here only together with every
 * module that reads it, and keep this file free of imports from the rest of the app.
 *
 * No real trip, place, price or date may appear in code, comments or tests (AGENTS.md).
 */

export type CatalogueEdition = "quick" | "complete" | "preview";

/** Asia/Ulaanbaatar calendar day, YYYY-MM-DD. The ONLY notion of "today" in this feature. */
export type IsoDay = string;

export type CatalogueWarningSeverity = "info" | "warning" | "blocking";

export type CatalogueWarningCode =
  | "price_missing" //          no usable future dated adult fare -> card shows "Үнэ лавлах"
  | "price_conflict" //         prose price in the description disagrees with the dated fare
  | "price_zero" //             0₮ treated as missing data, never "free"
  | "no_future_departure" //    no bookable future date -> neutral date wording
  | "dates_missing"
  | "photo_missing" //          no usable approved photo -> controlled placeholder, editorial review
  | "photo_low_resolution"
  | "photo_fetch_failed"
  | "highlights_missing"
  | "internal_copy_dropped" //  staff/bot instruction text removed from customer copy
  | "stale_published" //        published version no longer matches live data
  | "code_collision"
  | "category_unknown"
  | "other";

export type CatalogueWarning = {
  code: CatalogueWarningCode;
  severity: CatalogueWarningSeverity;
  /** Mongolian, written for staff. */
  message: string;
  tripId?: string;
  /** Machine-readable detail for admin diagnostics, e.g. {overviewMnt, datedMnt}. Never PII. */
  detail?: Record<string, string | number | boolean | null>;
};

export type CataloguePrice =
  | {
      kind: "from";
      /** Minimum ADULT price among future, offered departures. Never a sum, never inferred. */
      amountMnt: number;
      /** The departure that price belongs to, when one date carries it. */
      date: IsoDay | null;
      /** "3,980,000₮-с" */
      display: string;
    }
  | { kind: "inquire"; display: "Үнэ лавлах" };

export type CatalogueDateInfo = {
  /** Earliest future offered departure, or null. */
  nextDeparture: IsoDay | null;
  /** Future offered departures, ascending, at most 12. */
  departures: IsoDay[];
  /** Human line for the card, e.g. "2027.01.09-ний хөдлөлт" or "Явах огноог лавлана". Never invented. */
  label: string;
};

/** Focal point of a photo, 0..1 from the top-left. Used for the crop; never changes the file. */
export type PhotoFocal = { x: number; y: number };

export type CataloguePhotoQuality = "excellent" | "good" | "weak" | "missing";

/** One selectable photo for a trip, with the real measured size and why it was (not) ranked high. */
export type CataloguePhotoCandidate = {
  url: string;
  width: number | null;
  height: number | null;
  source: "poster_hero" | "trip_photo" | "poster_day";
  /** 0..100, higher = better hero. Resolution, aspect/crop headroom, source, text-overlay risk. */
  score: number;
  /** Mongolian, staff-facing: "нягтрал бага (640px)", "текст/постер байж магадгүй", ... */
  issues: string[];
  credit: string | null;
};

/** Staff choice of the hero for one trip. Touches no price, date or title of the trip. */
export type CatalogueHeroChoice = { url: string; focal?: PhotoFocal | null; zoom?: number | null };

export type CataloguePhoto = {
  /** https URL the renderer may fetch. Approved, destination-relevant trip photo already stored for the trip. */
  url: string;
  width: number | null;
  height: number | null;
  credit: string | null;
  /** Where it came from, for the admin's "image source" column. */
  source: "poster_hero" | "trip_photo" | "poster_day";
  /** Crop focal point (staff choice or detected). null = centre/attention crop. */
  focal?: PhotoFocal | null;
  zoom?: number | null;
};

export type CatalogueTripCard = {
  tripId: string;
  /** Stable code ("A01"). Persisted per trip id in the store; never reused, never renumbered. */
  code: string;
  /** Canonical trip title exactly as stored (identity). Never shortened here. */
  title: string;
  /** Concise editorial display title derived from the canonical one (or a staff override). Display only. */
  editorialTitle: string;
  /** Destination identity used for diversity ("one place, one slot"): a normalised destination name, "" when unknown. */
  destinationKey: string;
  /** How good the chosen hero is for a premium book. "weak"/"missing" => flagged for replacement. */
  heroQuality: CataloguePhotoQuality;
  /** Up to two extra GOOD photos of this same trip for secondary compositions (never the hero). */
  gallery: CataloguePhoto[];
  /** Short human-friendly line above the title, e.g. "<region> / <country>". Derived from trip data. */
  kicker: string;
  /** Group key (see CatalogueGroup). From trip metadata + admin curation, never hardcoded per destination. */
  groupKey: string;
  durationText: string;
  /** "Шууд нислэг" | "Газрын аялал" | "Галт тэрэг" ... derived from trip.extra.transport_type. */
  transportLabel: string;
  /** At most three short, real, customer-safe highlights. */
  highlights: string[];
  price: CataloguePrice;
  dates: CatalogueDateInfo;
  /** Official page, optional link target only. Offline reading must not depend on it. */
  detailUrl: string | null;
  photo: CataloguePhoto | null;
  warnings: CatalogueWarning[];
};

export type CatalogueGroup = {
  key: string;
  /** Mongolian label, e.g. "Далайн амралт". */
  label: string;
  /** Codes in display order. */
  codes: string[];
};

export type CatalogueContact = {
  phones: string[];
  siteLabel: string;
  siteUrl: string;
};

export type CatalogueSnapshot = {
  edition: CatalogueEdition;
  /** ISO timestamp, set by the caller (never read from the clock inside pure builders). */
  generatedAt: string;
  asOfDay: IsoDay;
  /** "2026.11.06" style label printed on cover and closing page. */
  issueLabel: string;
  /** Season/year line, e.g. "2026 / 2027". Derived from asOfDay and departures. */
  seasonLabel: string;
  trips: CatalogueTripCard[];
  /** Trip chosen for the cover: best hero quality + visual appeal, never "most recently edited". */
  coverTripId: string | null;
  groups: CatalogueGroup[];
  contact: CatalogueContact;
  /** Collection-level warnings plus every trip warning, flattened, for the admin. */
  warnings: CatalogueWarning[];
  /** sha256 over everything the PDF would print. Same live data + same config => same hash. */
  contentHash: string;
};

/** What staff curate in the admin. Never holds prices, dates or titles. */
export type CatalogueEditionConfig = {
  /** Ordered. For "complete" this is ignored except for ordering overrides. */
  tripIds: string[];
  /** Admin override: tripId -> groupKey. */
  groupOverrides: Record<string, string>;
  /** Trip ids shown first / on the cover strip. */
  featuredTripIds: string[];
  /** tripIds staff excluded even though eligible. */
  excludedTripIds: string[];
};

export type CatalogueConfig = {
  /** Staff-picked hero photo + crop per trip id (shared by every edition). */
  heroByTripId: Record<string, CatalogueHeroChoice>;
  /** Staff display-title overrides per trip id (display only). */
  titleOverrides: Record<string, string>;
  quick: CatalogueEditionConfig;
  complete: CatalogueEditionConfig;
  preview: CatalogueEditionConfig;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** Everything buildCatalogueSnapshot needs; pure input so snapshots are deterministic. */
export type SnapshotInput = {
  edition: CatalogueEdition;
  nowIso: string;
  /** Live trips exactly as the chatbot's canonical store returns them. */
  trips: import("../travelTypes").TravelTrip[];
  /** Poster data per trip id (hero photo, day photos), when linked. */
  posterByTripId: Record<string, unknown>;
  config: CatalogueEditionConfig;
  heroByTripId?: Record<string, CatalogueHeroChoice>;
  titleOverrides?: Record<string, string>;
  codeMap: Record<string, string>;
  contactPhones: string[];
  siteBaseUrl: string;
};

export type RenderedCatalogue = {
  pdf: Buffer;
  pageCount: number;
  /** JPEG per page, same order, for the admin preview and the phone-size QA. Empty when not requested. */
  pageImages: Buffer[];
  /** Page size in PDF points. */
  pageSize: { width: number; height: number };
  fonts: string[];
  renderMs: number;
  warnings: CatalogueWarning[];
};

export type CatalogueVersionStatus = "draft" | "published" | "superseded";

export type CatalogueVersionMeta = {
  id: string;
  edition: CatalogueEdition;
  /** Monotonic per edition: 1, 2, 3 ... */
  versionNo: number;
  /** "UUDAM_Corporate_2026-11-06_v3.pdf" */
  fileName: string;
  status: CatalogueVersionStatus;
  sizeBytes: number;
  pageCount: number;
  sha256: string;
  contentHash: string;
  tripCount: number;
  generatedAt: string;
  generatedBy: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  /** Unguessable token in the public file URL. Not a secret credential; never contains PII. */
  publicToken: string;
  warnings: CatalogueWarning[];
};

export type CatalogueIntent =
  | { kind: "none" }
  | { kind: "catalogue"; edition: "quick" | "complete"; resend: boolean; matched: string }
  | { kind: "group_quote"; matched: string };

export type TripCodeRequest = {
  code: string;
  /** People count when stated, else null. */
  groupSize: number | null;
  /** 1-12 when a month was stated, else null. */
  month: number | null;
  raw: string;
};

export type CatalogueDeliveryStatus =
  | "sent"
  | "sent_link_fallback"
  | "duplicate_suppressed"
  | "blocked_staff_owned"
  | "blocked_paused"
  | "blocked_window"
  | "blocked_killswitch"
  | "no_published_version"
  | "stale_fallback"
  | "dry_run"
  | "failed";

export type CatalogueDeliveryOutcome = {
  status: CatalogueDeliveryStatus;
  versionId: string | null;
  edition: CatalogueEdition;
  /** Meta message id when Meta returned one. */
  metaMessageId: string | null;
  /** Machine-readable reason on every non-"sent" outcome. */
  reason: string | null;
  /** True only when Meta accepted the file. The caller must never claim a send otherwise. */
  fileAccepted: boolean;
};

/** The only admin URL space for this feature. */
export const CATALOGUE_ADMIN_API = "/api/admin/catalogue";
/** Public, token-addressed PDF (Meta and phones can fetch it). */
export const CATALOGUE_PUBLIC_FILE_PATH = "/api/catalogue/file";

export const CATALOGUE_QUICK_MIN_TRIPS = 8;
export const CATALOGUE_QUICK_MAX_TRIPS = 12;
