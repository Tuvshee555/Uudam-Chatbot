/**
 * One definition of "this trip is missing something a customer will ask for".
 *
 * Shared by the admin trip list, the trip editor's save guard, the trips API
 * and the poster sync, so a gap is named identically everywhere instead of
 * each screen inventing its own idea of complete. Pure rules — no DB, no env,
 * so both the browser and the server can import it.
 */

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
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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
    ok: (t) => money(t.child_price) },
  { key: "departure_dates", label: "Гарах өдөр", where: "Үнэ ба гаралт", severity: "blocking",
    ok: (t) => filled(t.departure_dates) },
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
