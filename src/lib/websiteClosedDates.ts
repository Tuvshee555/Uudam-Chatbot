/**
 * Live trips whose website dates are closed because no price could be read (admin System page).
 *
 * Why (owner, 2026-11-22): a new trip went live and the website paused all 20 of its departures.
 * Its child fare's age («11 наснаас доош») could not be read, so every date had no price to show,
 * and nothing anywhere said so: the bot called the trip full and the assistant called it open.
 * A date the website pauses for that reason carries no price in the trip's last projection
 * (websiteTripPayload); a date staff paused keeps its price, so it is never reported here.
 */
import type { ReadinessIssue } from "./readiness";

export type ClosedForNoPriceRow = { title: string; closed: number; upcoming: number };

/** One issue per trip: critical when every upcoming date is closed, a warning otherwise. */
export function closedForNoPriceIssues(rows: ClosedForNoPriceRow[]): ReadinessIssue[] {
  return rows.filter((row) => row.closed > 0).map((row) => ({
    key: `website_closed_no_price:${row.title}`,
    severity: row.closed >= row.upcoming ? "critical" : "warning",
    message: `«${row.title}»: вэбсайтад ${row.closed}/${row.upcoming} огноо хаалттай, учир нь үнийг нь уншиж чадсангүй`
      + " (насны ангилал эсвэл үнийн мөрийг шалгана уу). Засмагц огноонууд өөрөө нээгдэнэ.",
  }));
}

/** The website's departures still ahead, closed for no readable price, counted per published trip. */
export const CLOSED_FOR_NO_PRICE_SQL = `
  SELECT t.title,
         COUNT(*) FILTER (WHERE d.status = 'PAUSED' AND d."seatsLeft" IS NULL AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(t."sourceMetadata"->'canonicalOffers'->'departures') = 'array'
               THEN t."sourceMetadata"->'canonicalOffers'->'departures' ELSE '[]'::jsonb END) p
            WHERE left(p->>'start', 10) = ((d."startDate" + interval '8 hours')::date)::text
              AND p->>'status' = 'PAUSED' AND (p->'price' IS NULL OR p->'price' = 'null'::jsonb)))::int AS closed,
         COUNT(*)::int AS upcoming
    FROM "Trip" t JOIN "Departure" d ON d."tripId" = t.id
   WHERE t."isPublished" AND t."sourceTripId" IS NOT NULL
     AND d.status NOT IN ('CANCELLED', 'DEPARTED')
     AND (d."startDate" + interval '8 hours')::date >= (NOW() + interval '8 hours')::date
   GROUP BY t.id, t.title`;
