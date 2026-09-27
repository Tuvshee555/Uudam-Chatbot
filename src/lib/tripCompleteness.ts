/**
 * One definition of "this trip is missing something a customer will ask for".
 *
 * Shared by the admin trip list, the trip editor's save guard, the trips API
 * and the poster sync, so a gap is named identically everywhere instead of
 * each screen inventing its own idea of complete. Pure rules — no DB, no env,
 * so both the browser and the server can import it.
 */

/**
 * A tugrik figure under 1,000 is never a real fare in this catalog — it is a
 * number typed to get past a required field ("1₮" for an untracked infant
 * fare). The bot already hides these from customers (formatPassengerMoney),
 * but the save guard should catch them at the source: a trip saved with one
 * still shows it in the admin and in any raw export, and the underlying "we
 * don't actually know this price" never gets fixed. Same threshold as
 * formatPassengerMoney's guard in travelFastPathsPricing.ts — kept as its own
 * small check here rather than importing that (much heavier) module.
 */
export function isPlaceholderTugrikFare(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1000;
}

/**
 * An unfilled poster-editor date row ("Шинэ огноо") or bracket placeholder
 * ("[огноо 1]") saved as if it were a real departure date. Mirrors
 * isPlaceholderDepartureText in travelDates.ts (kept independent here so this
 * module stays dependency-free; the wording must stay in sync with that
 * file's NEW_DATE_PLACEHOLDER).
 */
export function isPlaceholderDateText(text: string): boolean {
  const trimmed = text.trim();
  return /^\[[^\]]*\]$/.test(trimmed) || trimmed.toLowerCase() === "шинэ огноо";
}

export type TripGapSeverity = "blocking" | "warning";

export type TripGap = {
  key: string;
  /** Field name as the admin sees it. */
  label: string;
  /** Where to go and fix it. */
  where: string;
  severity: TripGapSeverity;
};

/** The trip facts completeness depends on, flattened out of trip + trip.extra. */
export type TripCompletenessInput = {
  route_name?: string | null;
  duration_text?: string | null;
  adult_price?: number | null;
  child_price?: number | null;
  infant_price?: number | null;
  /**
   * The operator explicitly documented this fare as free ("Нярай: Үнэгүй"),
   * as opposed to simply leaving it blank. A bare 0 still counts as missing
   * data — only a written-down free fare counts as filled.
   */
  infant_fare_free?: boolean;
  child_fare_free?: boolean;
  departure_dates?: readonly string[] | null;
  photo_urls?: readonly string[] | null;
  itinerary_days?: readonly unknown[] | null;
  has_brochure?: boolean;
  /**
   * Poster-linked trips keep their gallery on the poster, and that is what the
   * website publishes, so those count as photos even when photo_urls is empty.
   */
  poster_photo_count?: number;
};

type TripLike = {
  route_name?: string | null;
  duration_text?: string | null;
  adult_price?: number | null;
  child_price?: number | null;
  infant_price?: number | null;
  departure_dates?: readonly string[] | null;
  photo_urls?: readonly string[] | null;
  extra?: Record<string, unknown> | null;
};

function filled(value: readonly unknown[] | null | undefined): boolean {
  return Array.isArray(value) && value.some((item) => {
    if (typeof item === "string") return item.trim().length > 0;
    return item != null;
  });
}

function text(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function money(value: number | null | undefined): boolean {
  // A sub-1,000 figure ("1₮") is a placeholder, not a documented price — treat
  // it as still missing so the save guard asks for the real number instead of
  // silently accepting whatever got past the required-field check.
  return typeof value === "number" && Number.isFinite(value) && value >= 1000;
}

/** At least one departure date that is not an unfilled editor placeholder. */
function filledDates(value: readonly string[] | null | undefined): boolean {
  return Array.isArray(value) && value.some((item) => item.trim().length > 0 && !isPlaceholderDateText(item));
}

/**
 * A child_rules entry priced 0 whose note says "Үнэгүй" — the same convention
 * isDocumentedFreeFare() reads when the bot answers. Kept deliberately simple
 * here (no age-band reasoning): this only decides whether the admin still owes
 * us a number, not what price a customer is quoted.
 */
export function documentedFreeFare(
  extra: Record<string, unknown>,
  target: "child" | "infant",
): boolean {
  const rules = [extra.child_rules, extra.child_price_rules]
    .flatMap((value) => (Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []));
  return rules.some((rule) => {
    if (rule.price !== 0) return false;
    const note = String(rule.note ?? "").toLowerCase();
    if (!note.includes("үнэгүй") && !note.includes("free")) return false;
    const haystack = `${String(rule.label ?? "")} ${String(rule.age_range ?? "")}`.toLowerCase();
    const infantShaped = /нярай|infant|сар/.test(haystack);
    return target === "infant" ? infantShaped : !infantShaped;
  });
}

const RULES: Array<{
  key: string;
  label: string;
  where: string;
  severity: TripGapSeverity;
  ok: (input: TripCompletenessInput) => boolean;
}> = [
  { key: "route_name", label: "Аяллын нэр", where: "Үндсэн", severity: "blocking",
    ok: (t) => text(t.route_name) },
  { key: "duration_text", label: "Хугацаа", where: "Үндсэн", severity: "blocking",
    ok: (t) => text(t.duration_text) },
  { key: "adult_price", label: "Том хүний үнэ", where: "Үндсэн", severity: "blocking",
    ok: (t) => money(t.adult_price) },
  { key: "child_price", label: "Хүүхдийн үнэ", where: "Үндсэн", severity: "blocking",
    ok: (t) => money(t.child_price) || t.child_fare_free === true },
  // Infants have their own fare on every trip — customers ask, and 0/blank
  // would read as "babies fly free", a promise the agency never made. A fare
  // the operator DID write down as free is complete, not missing.
  { key: "infant_price", label: "Нярайн үнэ", where: "Үндсэн", severity: "blocking",
    ok: (t) => money(t.infant_price) || t.infant_fare_free === true },
  { key: "departure_dates", label: "Гарах өдөр", where: "Үнэ ба гаралт", severity: "blocking",
    ok: (t) => filledDates(t.departure_dates) },
  { key: "photo_urls", label: "Зураг", where: "Үндсэн", severity: "blocking",
    ok: (t) => filled(t.photo_urls) || (t.poster_photo_count ?? 0) > 0 },
  // Editable on the poster, not in this form — flag it, never block the save here.
  { key: "itinerary_days", label: "Өдрийн хөтөлбөр", where: "Хөтөлбөр", severity: "warning",
    ok: (t) => filled(t.itinerary_days) },
  { key: "brochure", label: "PDF хөтөлбөр", where: "Постер", severity: "warning",
    ok: (t) => t.has_brochure !== false },
];

export function findTripGaps(input: TripCompletenessInput): TripGap[] {
  return RULES.filter((rule) => !rule.ok(input)).map(({ key, label, where, severity }) => ({
    key, label, where, severity,
  }));
}

export function blockingGaps(gaps: readonly TripGap[]): TripGap[] {
  return gaps.filter((gap) => gap.severity === "blocking");
}

/** Flattens a stored trip (fields + extra) into the shape the rules read. */
export function tripCompletenessInput(
  trip: TripLike,
  options: { hasBrochure?: boolean; posterPhotoCount?: number } = {},
): TripCompletenessInput {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const list = (value: unknown) => (Array.isArray(value) ? value : null);
  return {
    poster_photo_count:
      options.posterPhotoCount ??
      (typeof extra.poster_photo_count === "number" ? extra.poster_photo_count : 0),
    route_name: trip.route_name,
    duration_text: trip.duration_text,
    adult_price: trip.adult_price,
    child_price: trip.child_price,
    infant_price: trip.infant_price,
    infant_fare_free: documentedFreeFare(extra, "infant"),
    child_fare_free: documentedFreeFare(extra, "child"),
    departure_dates: trip.departure_dates,
    photo_urls: trip.photo_urls,
    itinerary_days: list(extra.itinerary_days),
    has_brochure:
      options.hasBrochure ??
      Boolean(
        (typeof extra.poster_trip_id === "string" && extra.poster_trip_id.trim()) ||
          (typeof extra.brochure_pdf_url === "string" && extra.brochure_pdf_url.startsWith("https://")) ||
          (typeof extra.source_file_attachment_id === "string" && extra.source_file_attachment_id.trim()),
      ),
  };
}

/** "Үнэ, Гарах өдөр, Зураг" — for badges, warnings and review reasons. */
export function formatGapLabels(gaps: readonly TripGap[]): string {
  return gaps.map((gap) => gap.label).join(", ");
}

export const INCOMPLETE_REVIEW_PREFIX = "Дутуу мэдээлэл:";

/** The review reason poster sync stamps on a trip so staff see it in the admin. */
export function incompleteReviewReason(gaps: readonly TripGap[]): string {
  return `${INCOMPLETE_REVIEW_PREFIX} ${formatGapLabels(gaps)}`;
}
