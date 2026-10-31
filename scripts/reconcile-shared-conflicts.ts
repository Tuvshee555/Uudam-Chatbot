/**
 * One-off review of recorded website <-> chatbot conflicts (extra.shared_conflicts).
 *
 * Settles only conflicts whose outcome is objective, and keeps every one of
 * them in extra.resolved_conflicts with the reason, so nothing is discarded:
 *   - website_owns_availability: seats/sold-out states belong to the website,
 *     whose live rows the bot already reads;
 *   - converged: the canonical value now equals the website's value;
 *   - superseded: the canonical value changed again after the conflict was
 *     recorded, and the website shows that same newer value;
 *   - equivalent_schedule: the website's explicit dates are exactly the
 *     weekday rule the chatbot keeps (plus dated price-group departures).
 * Everything else stays open for a person to decide in the website admin.
 *
 * Dry run by default; `--apply` writes through patchTrip (versioned, synced).
 *   npx tsx scripts/reconcile-shared-conflicts.ts [--apply]
 */
import { queryNeon } from "../src/lib/neonDb";
import { patchTrip } from "../src/lib/travelDb";
import { sameParityValue } from "../src/lib/tripWebsiteParityValue";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const WEEKDAYS: Array<[RegExp, number]> = [[/даваа/i, 1], [/мягмар/i, 2], [/лхагва/i, 3], [/пүрэв/i, 4], [/баасан/i, 5], [/бямба/i, 6], [/ням/i, 0]];
const apply = process.argv.includes("--apply");

function canonicalValue(trip: Row, field: string): unknown {
  return field.startsWith("extra.") ? record(trip.extra)[field.slice(6)] : trip[field];
}

/** The website's current value for a canonical field, where it has one. */
function websiteValue(website: Row, field: string): unknown {
  if (field === "departure_dates") return website.dates;
  if (field === "route_name") return website.title;
  if (field === "notes") return website.description;
  if (field === "adult_price") return website.price;
  if (field === "child_price") return website.childPrice;
  if (field === "infant_price") return website.infantPrice;
  if (field === "hotel") return website.hotel;
  return undefined;
}

function equivalentSchedule(websiteDates: unknown, chatbotDates: unknown, priceGroups: unknown): boolean {
  if (!Array.isArray(websiteDates) || !Array.isArray(chatbotDates)) return false;
  const days = new Set(chatbotDates.flatMap((text) => WEEKDAYS.filter(([pattern]) => pattern.test(String(text))).map(([, day]) => day)));
  if (!days.size) return false;
  const dated = new Set((Array.isArray(priceGroups) ? priceGroups : []).map(record)
    .flatMap((group) => [...(Array.isArray(group.dates) ? group.dates : []), ...(Array.isArray(group.date_keys) ? group.date_keys : [])]).map(String));
  return websiteDates.every((date) => dated.has(String(date)) || days.has(new Date(`${String(date).slice(0, 10)}T00:00:00Z`).getUTCDay()));
}

function classify(trip: Row, website: Row, conflict: Row): string | null {
  const field = String(conflict.field || "");
  if (field === "extra.website_departure_availability") return "website_owns_availability";
  const current = canonicalValue(trip, field);
  if (current !== undefined && sameParityValue(current, conflict.website)) return "converged";
  const shown = websiteValue(website, field);
  if (current !== undefined && !sameParityValue(current, conflict.chatbot) && shown !== undefined) {
    const agree = field === "departure_dates" ? equivalentSchedule(shown, current, record(trip.extra).price_groups) || sameParityValue(shown, current) : sameParityValue(shown, current);
    if (agree) return "superseded";
  }
  if (field === "departure_dates" && sameParityValue(current, conflict.chatbot) && equivalentSchedule(conflict.website, current, record(trip.extra).price_groups)) return "equivalent_schedule";
  return null;
}

async function main() {
  const host = new URL(String(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL)).host.split(".")[0];
  console.log(`${apply ? "APPLYING to" : "Dry run on"} ${host}`);
  const rows = (await queryNeon<Row>(`SELECT c.*, t.title, t.description, t.price, t."childPrice", t."infantPrice", t.hotel AS website_hotel,
      (SELECT COALESCE(jsonb_agg(to_char(d."startDate", 'YYYY-MM-DD') ORDER BY d."startDate"), '[]'::jsonb) FROM "Departure" d
        WHERE d."tripId"=t.id AND d.status NOT IN ('CANCELLED','DEPARTED')) AS website_dates
    FROM travel_trip_entries c JOIN "Trip" t ON t."sourceTripId"=c.id
    WHERE jsonb_typeof(c.extra->'shared_conflicts')='array' AND jsonb_array_length(c.extra->'shared_conflicts')>0`))?.rows ?? [];
  const resolvedAt = new Date().toISOString();
  let settled = 0, kept = 0;
  for (const trip of rows) {
    const website = { title: trip.title, description: trip.description, price: trip.price, childPrice: trip.childPrice, infantPrice: trip.infantPrice, hotel: trip.website_hotel, dates: trip.website_dates };
    const conflicts = (record(trip.extra).shared_conflicts as Row[]);
    const open: Row[] = [];
    const resolved: Row[] = [];
    for (const conflict of conflicts) {
      const reason = classify(trip, website, conflict);
      if (reason) resolved.push({ ...conflict, resolution: `auto:${reason}`, resolvedAt, resolvedBy: "reconcile-shared-conflicts 2026-10-31" });
      else open.push(conflict);
    }
    settled += resolved.length; kept += open.length;
    const reasons = resolved.reduce<Record<string, number>>((all, entry) => ({ ...all, [String(entry.resolution)]: (all[String(entry.resolution)] || 0) + 1 }), {});
    console.log(`- ${String(trip.route_name).slice(0, 55)}: ${conflicts.length} → settle ${resolved.length} ${JSON.stringify(reasons)}, keep ${open.length}${open.length ? ` [${[...new Set(open.map((c) => c.field))].join(", ")}]` : ""}`);
    if (apply && resolved.length) {
      const previous = Array.isArray(record(trip.extra).resolved_conflicts) ? record(trip.extra).resolved_conflicts as Row[] : [];
      const saved = await patchTrip(String(trip.id), { extra: { shared_conflicts: open, resolved_conflicts: [...previous, ...resolved].slice(-200) } });
      if (!saved) throw new Error(`Could not save ${String(trip.id)}`);
    }
  }
  console.log(`Total: settle ${settled}, keep ${kept} for review${apply ? " (applied)" : " (dry run)"}`);
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
