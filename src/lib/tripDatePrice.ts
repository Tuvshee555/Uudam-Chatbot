/**
 * "12/2-ны үнийг 100 мянгаар нэм": one departure date's fare, changed on that date only.
 *
 * - The date's price row is split out of the row it shares with other dates
 *   (adminDatePricing.patchPricingDate, as the editor does), so the other dates keep their fare.
 * - Each fare is an exact amount ({set}) or a shift ({delta}), per passenger: adult, child,
 *   infant, single (own room). `band` names the passenger tier when a row has several child
 *   tiers, `hotel` / `package_id` the row when the date is sold per hotel or package. Nothing is
 *   guessed: an ambiguous row or tier, a shift on a fare the date does not have, a non-tugrik row
 *   and a partner-synced trip are refused with the reason in Mongolian.
 * - The poster price table is brought along in the same write (poster/priceTableWrite), or a
 *   later Poster-tab save would put the old fare back; when that cannot be done the review says so.
 *
 * Pure: the caller reads the trip and its poster and saves the result through patchTrip.
 */
import { patchPricingDate, pricingDates, pricingDays } from "./adminDatePricing";
import type { PriceGroup } from "./adminTypes";
import { mismatchedRowsText, syncPosterPriceTable } from "./poster/priceTableWrite";
import { deriveChildRules, withDerivedSummaryFields } from "./priceGroups";
import { isInfantShapedAge } from "./travelFastPathsSearch";
import { formatMnt } from "./tripFareChange";
import type { FareAmount, TravelTrip, TripMutationFields } from "./travelTypes";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const norm = (value: unknown): string => text(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ");
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_FARE_MNT = 200_000_000;
/** Below this a tugrik fare is almost certainly a typo ("42,900" for 42,900,000) — same bar as the brain's fareWarnings. */
const MIN_SANE_FARE = 100_000;

export type FareKind4 = "adult" | "child" | "infant" | "single";
const KINDS: FareKind4[] = ["adult", "child", "infant", "single"];
export const DATE_FARE_WORDS: Record<FareKind4, string> = { adult: "насанд хүрэгч", child: "хүүхэд", infant: "нярай", single: "ганцаараа" };

export type DatePriceInput = {
  date?: unknown; adult?: unknown; child?: unknown; infant?: unknown; single?: unknown;
  band?: unknown; hotel?: unknown; package_id?: unknown;
};

export type DateFareChange = { kind: FareKind4; label: string; before: number | null; after: number };

export type DatePricePlan = {
  fields: TripMutationFields;
  /** The poster with its price table brought in line, when the trip has a poster table. */
  poster?: Row;
  posterKeys: string[];
  lines: string[];
  warnings: string[];
  changes: DateFareChange[];
};

export type Planned<T> = { ok: true; plan: T } | { ok: false; reason: string };

/** "12/2" — the short day the owner writes. */
export function shortDay(date: string): string {
  return ISO.test(date) ? `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}` : date;
}

/** A fare amount as the action carries it: {set: n} or {delta: n}, whole tugrik, within range; "bad" otherwise. */
export function fareAmountOf(value: unknown): FareAmount | null | "bad" {
  if (value === undefined || value === null) return null;
  const row = record(value);
  const set = typeof row.set === "number" && Number.isFinite(row.set) ? Math.round(row.set) : null;
  const delta = typeof row.delta === "number" && Number.isFinite(row.delta) ? Math.round(row.delta) : null;
  if ((set === null) === (delta === null)) return "bad";
  if (set !== null) return set >= 0 && set <= MAX_FARE_MNT ? { set } : "bad";
  return delta !== 0 && Math.abs(delta as number) <= MAX_FARE_MNT ? { delta: delta as number } : "bad";
}

export function partnerSourceUrl(trip: Pick<TravelTrip, "extra">): string {
  return text(record(trip.extra?.partner_sync).source_url);
}

export const PARTNER_EDIT_REASON = "хамтрагчийн сайтаас 30 минут тутам автоматаар шинэчлэгддэг тул үнэ, огноо, огнооны төлвийг гараар засахгүй (дараагийн шинэчлэлт буцааж дарна). Хамтрагч талдаа засуулна уу.";

function rowLabel(row: Row): string {
  return [text(row.hotel), text(row.package_id)].filter(Boolean).join(" · ") || text(row.label) || "үнийн мөр";
}

function hotelFits(row: Row, hotel: string, packageId: string): boolean {
  if (hotel && norm(row.hotel) !== norm(hotel) && !norm(row.label).includes(norm(hotel)) && !norm(row.hotel).includes(norm(hotel))) return false;
  if (packageId && text(row.package_id) !== packageId) return false;
  return true;
}

function tierName(tier: Row): string {
  const label = text(tier.label);
  const age = text(tier.age_range);
  return label && age && !label.includes(age) ? `${label} ${age}` : label || age || "ангилал";
}
const isInfantTier = (tier: Row) => isInfantShapedAge(text(tier.label).toLowerCase(), text(tier.age_range));

function bandMatches(tier: Row, band: string): boolean {
  const wanted = norm(band);
  const label = norm(tier.label);
  const age = norm(tier.age_range);
  return label === wanted || age === wanted || `${label} ${age}`.trim() === wanted || (wanted.length >= 3 && (label.includes(wanted) || (age !== "" && wanted.includes(age))));
}

/** Slips worth a second look on one date's fares (the brain's fareWarnings, for a price row). */
export function datePriceWarnings(before: Record<string, number | null>, after: Record<string, number | null>): string[] {
  const out: string[] = [];
  for (const kind of ["adult", "child", "infant"] as const) {
    const value = after[kind];
    const was = before[kind];
    if (typeof value !== "number" || value === was) continue;
    if (value > 0 && value < MIN_SANE_FARE) out.push(`${DATE_FARE_WORDS[kind]} ${formatMnt(value)} — хэт бага харагдаж байна. ${formatMnt(value * 1000)} гэсэн үү?`);
    else if (typeof was === "number" && was > 0 && value > 0 && (value >= was * 3 || value * 3 <= was)) {
      out.push(`${DATE_FARE_WORDS[kind]} ${formatMnt(was)} → ${formatMnt(value)}: ${(Math.max(value, was) / Math.min(value, was)).toFixed(1)} дахин өөрчлөлт. Зөв үү?`);
    }
  }
  const { adult, child, infant } = after;
  if (typeof child === "number" && typeof adult === "number" && child > adult) out.push(`Хүүхдийн үнэ (${formatMnt(child)}) насанд хүрэгчийнхээс (${formatMnt(adult)}) өндөр болно.`);
  if (typeof infant === "number" && typeof child === "number" && child > 0 && infant > child) out.push(`Нярайн үнэ (${formatMnt(infant)}) хүүхдийнхээс (${formatMnt(child)}) өндөр болно.`);
  return out;
}

export function planDatePrice(trip: TravelTrip, input: DatePriceInput, posterData: unknown | null, now: Date = new Date()): Planned<DatePricePlan> {
  const fail = (reason: string): Planned<DatePricePlan> => ({ ok: false, reason });
  const date = text(input.date);
  if (!ISO.test(date)) return fail("Үнэ өөрчлөх огноог YYYY-MM-DD хэлбэрээр заана уу.");
  const day = shortDay(date);
  if (partnerSourceUrl(trip)) return fail(`«${trip.route_name}» ${PARTNER_EDIT_REASON}`);
  const amounts: Partial<Record<FareKind4, FareAmount>> = {};
  for (const kind of KINDS) {
    const amount = fareAmountOf(input[kind]);
    if (amount === "bad") return fail(`${DATE_FARE_WORDS[kind]} үнийн дүн буруу байна (шинэ үнэ эсвэл +/− өөрчлөлтийн аль нэг, 0–200 сая ₮).`);
    if (amount) amounts[kind] = amount;
  }
  if (!Object.keys(amounts).length) return fail(`${day}: ямар үнийг хэдээр өөрчлөхийг заагаагүй байна.`);

  const groups = records(trip.extra?.price_groups);
  if (!groups.length) {
    return fail(`«${trip.route_name}» аялалд огноогоор тусдаа үнэ алга — бүх огноо нэг үнэтэй. Аяллын үнийг бүх огноонд өөрчлөх үү, эсвэл «Аяллууд» хэсэгт ${day}-нд үнийн мөр нэмэх үү?`);
  }
  const hotel = text(input.hotel);
  const packageId = text(input.package_id);
  const onDate = groups.map((group, index) => ({ group, index })).filter(({ group }) => pricingDays(group, now).includes(date));
  if (!onDate.length) return fail(`«${trip.route_name}» аялалд ${day}-нд үнийн мөр алга.`);
  const hits = onDate.filter(({ group }) => hotelFits(group, hotel, packageId));
  if (!hits.length) return fail(`${day}-нд «${[hotel, packageId].filter(Boolean).join(" · ")}» үнийн мөр алга (байгаа: ${onDate.map(({ group }) => rowLabel(group)).join(", ")}).`);
  if (hits.length > 1) return fail(`${day}-нд ${hits.length} үнийн мөр байна (${hits.map(({ group }) => rowLabel(group)).join(", ")}) — алийг нь өөрчлөхийг (буудал эсвэл багц) тодруулна уу.`);
  const { group: row, index: groupIndex } = hits[0];
  const currency = (text(row.currency) || trip.currency || "MNT").toUpperCase();
  if (currency !== "MNT") return fail(`${day}-ны үнэ ${currency}-ээр бичигдсэн; зарах үнэ зөвхөн төгрөгөөр тул энд өөрчлөхгүй.`);

  const tiers = records(row.passenger_prices).map((tier) => ({ ...tier }));
  const band = text(input.band);
  const next: Row = {};
  const changes: DateFareChange[] = [];
  const apply = (kind: FareKind4, label: string, before: number | null): number | string => {
    const amount = amounts[kind] as FareAmount;
    if ("set" in amount) return amount.set;
    if (before === null) return `${day}-нд ${label} үнэ бүртгэлгүй тул +/− хийх боломжгүй; шинэ үнийг шууд бичнэ үү.`;
    const after = before + amount.delta;
    return after < 0 ? `${day}: ${label} үнэ ${formatMnt(before)} — ${formatMnt(Math.abs(amount.delta))}-аар хасвал 0-оос доош болно.` : after;
  };

  if (amounts.adult) {
    const before = num(row.adult_price);
    const after = apply("adult", DATE_FARE_WORDS.adult, before);
    if (typeof after === "string") return fail(after);
    if (after !== before) {
      next.adult_price = after;
      const range = record(row.adult_price_range);
      const amount = amounts.adult;
      next.adult_price_range = "delta" in amount && num(range.min) !== null && num(range.max) !== null
        ? { ...range, min: (range.min as number) + amount.delta, max: (range.max as number) + amount.delta }
        : null;
      changes.push({ kind: "adult", label: DATE_FARE_WORDS.adult, before, after });
    }
  }

  for (const kind of ["child", "infant"] as const) {
    if (!amounts[kind]) continue;
    const pool = tiers.map((tier, index) => ({ tier, index })).filter(({ tier }) => (kind === "infant") === isInfantTier(tier));
    const useBand = band && (kind === "child" || !amounts.child);
    let target: { tier: Row; index: number } | null = null;
    if (useBand) {
      const matches = pool.filter(({ tier }) => bandMatches(tier, band));
      if (matches.length !== 1) {
        return fail(matches.length
          ? `${day}-нд «${band}» гэсэн ${matches.length} ангилал таарч байна (${matches.map(({ tier }) => tierName(tier)).join(", ")}) — нэгийг нь яг нэрээр нь заана уу.`
          : `${day}-нд «${band}» гэсэн ${DATE_FARE_WORDS[kind]}ийн ангилал алга (байгаа: ${pool.map(({ tier }) => tierName(tier)).join(", ") || "—"}).`);
      }
      target = matches[0];
    } else if (pool.length > 1) {
      return fail(`${day}-нд ${DATE_FARE_WORDS[kind]}ийн ${pool.length} ангилал байна (${pool.map(({ tier }) => tierName(tier)).join(", ")}) — алийг нь өөрчлөхийг тодруулна уу.`);
    } else if (pool.length === 1) {
      target = pool[0];
    } else if (tiers.length) {
      return fail(`${day}-нд ${DATE_FARE_WORDS[kind]}ийн үнийн ангилал алга — шинэ ангиллыг «Аяллууд» хэсэгт насны хамт нэмнэ үү.`);
    }
    if (target) {
      const before = num(target.tier.price);
      const after = apply(kind, `${DATE_FARE_WORDS[kind]} (${tierName(target.tier)})`, before);
      if (typeof after === "string") return fail(after);
      if (after === before) continue;
      const tier = tiers[target.index];
      tier.price = after;
      if (after === 0) tier.note = "Үнэгүй";
      else if (tier.note === "Үнэгүй") delete tier.note;
      changes.push({ kind, label: pool.length > 1 || useBand ? `${DATE_FARE_WORDS[kind]} (${tierName(target.tier)})` : DATE_FARE_WORDS[kind], before, after });
    } else {
      const key = `${kind}_price`;
      const before = num(row[key]);
      const after = apply(kind, DATE_FARE_WORDS[kind], before);
      if (typeof after === "string") return fail(after);
      if (after === before) continue;
      next[key] = after;
      changes.push({ kind, label: DATE_FARE_WORDS[kind], before, after });
    }
  }

  if (amounts.single) {
    const before = num(row.single_price);
    const after = apply("single", DATE_FARE_WORDS.single, before);
    if (typeof after === "string") return fail(after);
    if (after !== before) {
      next.single_price = after;
      changes.push({ kind: "single", label: DATE_FARE_WORDS.single, before, after });
    }
  }
  if (!changes.length) return fail(`${day}-ны үнэ аль хэдийн ийм байна.`);

  if (tiers.length && changes.some((change) => change.kind === "child" || change.kind === "infant")) {
    const derived = withDerivedSummaryFields({ ...row, passenger_prices: tiers } as unknown as PriceGroup) as unknown as Row;
    Object.assign(next, { passenger_prices: tiers, child_price: derived.child_price, child_age: derived.child_age, infant_price: derived.infant_price, infant_age: derived.infant_age });
  }
  const rowDates = pricingDays(row, now);
  // A row that spells its dates as text ("2026 оны 12 сарын 02") is split on calendar days.
  const spelled = pricingDates(row, now).some((value) => !ISO.test(value));
  const splittable = spelled ? groups.map((group, index) => (index === groupIndex ? { ...group, dates: rowDates, date_keys: rowDates, display_dates: rowDates } : group)) : groups;
  let nextGroups = patchPricingDate(splittable, { groupIndex, date }, next, now);
  if (rowDates.length > 1) {
    // The row's label used to list its dates; each half now lists its own.
    const listed = [text(row.label), ...[row.display_dates, row.dates].map((value) => (Array.isArray(value) ? value.map(String).join(", ") : ""))];
    if (text(row.label) && listed.slice(1).includes(text(row.label))) {
      const remaining = rowDates.filter((entry) => entry !== date);
      nextGroups = nextGroups.map((group, index) => (index === groupIndex ? { ...group, label: remaining.join(", ") } : index === groupIndex + 1 ? { ...group, label: date } : group));
    }
  }
  const fields: TripMutationFields = {
    extra: {
      price_groups: nextGroups,
      child_rules: deriveChildRules(nextGroups as unknown as PriceGroup[], { child: trip.child_price === 0, infant: trip.infant_price === 0 }),
    },
  };

  const where = text(row.hotel) || text(row.package_id) ? ` (${rowLabel(row)})` : "";
  const lines = changes.map((change) => `${day}${where}: ${change.label} ${formatMnt(change.before)} → ${formatMnt(change.after)}`);
  const beforeFares = { adult: num(row.adult_price), child: num(row.child_price), infant: num(row.infant_price) };
  const after = record(nextGroups[rowDates.length > 1 ? groupIndex + 1 : groupIndex]);
  const warnings = datePriceWarnings(beforeFares, { adult: num(after.adult_price), child: num(after.child_price), infant: num(after.infant_price) });
  if (rowDates.length > 1) lines.push(`Бусад ${rowDates.length - 1} огнооны үнэ хэвээр үлдэнэ.`);

  let poster: Row | undefined;
  const posterKeys: string[] = [];
  if (posterData && typeof posterData === "object") {
    const sync = syncPosterPriceTable(posterData, nextGroups, record(trip.extra), now);
    if (sync.problem) {
      warnings.push(`Постерын үнийн хүснэгтийг шинэчилж чадсангүй (${sync.problem}) — Постер табаас хадгалбал ${day}-ны үнэ буцна. Постерын хүснэгтийг тэнд гараар засна уу.`);
    } else if (sync.table) {
      poster = { ...record(posterData), price_table: sync.table };
      posterKeys.push("price_table");
    }
    const hasTable = records(record(record(posterData).price_table).rows).length > 0;
    if (!sync.problem && hasTable && !sync.coveredDates.includes(date)) {
      warnings.push(sync.mismatched?.length
        ? `Постерын үнийн хүснэгтэд ${day}-ны үнэ орсонгүй (${mismatchedRowsText(sync.mismatched)}) — Постер табаас хадгалбал ${day}-ны үнэ буцна. Постерын хүснэгтийг тэнд гараар засна уу.`
        : `Постерын үнийн хүснэгтэд ${day}-ны мөр алга — Постер табаас хадгалбал энэ огнооны үнийн мөр алга болж магадгүй.`);
    }
  }
  return { ok: true, plan: { fields, ...(poster ? { poster } : {}), posterKeys, lines, warnings, changes } };
}
