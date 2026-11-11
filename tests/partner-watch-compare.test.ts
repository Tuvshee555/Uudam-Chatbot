import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText } from "../src/lib/assistantAgent/webPage";
import { compareWithTrip, resolveRowDays, seatChangeProblem } from "../src/lib/partnerWatch/compare";
import { runPartnerWatch, type WatchDeps } from "../src/lib/partnerWatch/run";
import { parseScheduleTables } from "../src/lib/partnerWatch/scheduleTable";
import type { AITripAction, TravelTrip } from "../src/lib/travelTypes";

/**
 * The partner watch on invented trips and pages (no real trip, price or date): the page compared
 * with the trip made from it, seat states applied through the assistant's own set_date_state,
 * prices / new / vanished dates only recorded, one fetch per page, failures recorded not thrown.
 */

const NOW = new Date("2098-11-20T04:00:00Z");
const VERSION = "2098-11-01T00:00:00.000Z";
const URL = "https://partner.example/tours/norvel";

function trip(fields: Partial<TravelTrip> & Pick<TravelTrip, "id" | "route_name">): TravelTrip {
  return {
    category: "", operator_name: "UUDAM TRAVEL AGENCY", duration_text: "8 өдөр 7 шөнө", adult_price: 2_590_000, child_price: 2_490_000, infant_price: 0,
    currency: "MNT", departure_dates: [], seats_total: null, seats_left: null, has_food: true, status: "active", notes: "", hotel: "",
    source_description: "", photo_urls: [], extra: {}, created_at: VERSION, updated_at: VERSION, ...fields,
  };
}

const row = (date: string, adult: number, ortoi: number, orgui: number, more: Record<string, unknown> = {}) => ({
  label: "", dates: [date], adult_price: adult, child_price: ortoi, infant_price: 0,
  passenger_prices: [{ label: "Хүүхэд ортой", age_range: "", price: ortoi }, { label: "Хүүхэд ор эзлэхгүй", age_range: "2-11 нас", price: orgui }],
  ...more,
});

const NORVEL = trip({
  id: "t-watch-norvel", route_name: "ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ",
  departure_dates: ["2098-12-05", "2098-12-12", "2098-12-19", "2099-01-09"],
  extra: {
    source_url: URL,
    price_groups: [
      row("2098-12-05", 2_590_000, 2_490_000, 1_990_000),
      row("2098-12-12", 2_890_000, 2_790_000, 2_190_000),
      row("2098-12-19", 2_890_000, 2_790_000, 2_190_000, { status: "almost_full", seats_left: 3 }),
      row("2099-01-09", 2_990_000, 2_890_000, 2_290_000),
    ],
    website_departure_availability: [
      { date: "2098-12-05", status: "OPEN", seatsLeft: null },
      { date: "2098-12-12", status: "OPEN", seatsLeft: null },
      { date: "2098-12-19", status: "ALMOST_FULL", seatsLeft: 3 },
      { date: "2099-01-09", status: "OPEN", seatsLeft: null },
    ],
  },
});

const td = (cells: string[]) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
const HEADER = ["Бүртгэл", "Аялал гарах өдөр", "Аялал ирэх өдөр", "Том хүн", "Хүүхэд ортой", "Хүүхэд оргүй"];
const pageText = (rows: string[][]) => htmlToText(`<h1>Норвел</h1><table>${[HEADER, ...rows].map(td).join("")}</table><p>Нярай үнэгүй.</p>`).text;
// What the partner page says today: 12/5 adult +100k, 12/12 full and its no-bed child +50k, 12/19 two seats, 12/26 new, 1/9 gone.
const TODAY = pageText([
  ["бүртгэж байна", "12 сарын 05", "12 сарын 12", "2,690,000 төг", "2,490,000 төг", "1,990,000 төг"],
  ["дүүрсэн", "12 сарын 12", "12 сарын 19", "2,890,000 төг", "2,790,000 төг", "2,240,000 төг"],
  ["2 суудал үлдсэн", "12 сарын 19", "12 сарын 26", "2,890,000 төг", "2,790,000 төг", "2,190,000 төг"],
  ["бүртгэж байна", "12 сарын 26", "01 сарын 02", "3,190,000 төг", "3,090,000 төг", "2,390,000 төг"],
]);
const SAME = pageText([
  ["бүртгэж байна", "12 сарын 05", "12 сарын 12", "2,590,000 төг", "2,490,000 төг", "1,990,000 төг"],
  ["бүртгэж байна", "12 сарын 12", "12 сарын 19", "2,890,000 төг", "2,790,000 төг", "2,190,000 төг"],
  ["3 суудал үлдсэн", "12 сарын 19", "12 сарын 26", "2,890,000 төг", "2,790,000 төг", "2,190,000 төг"],
  ["бүртгэж байна", "1 сарын 09", "1 сарын 16", "2,990,000 төг", "2,890,000 төг", "2,290,000 төг"],
]);

function rowsOf(text: string) {
  const parsed = parseScheduleTables(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return parsed.ok ? parsed.rows : [];
}

test("the page as the trip was made from it: nothing to report", () => {
  assert.deepEqual(compareWithTrip(NORVEL, rowsOf(SAME), NOW).items, []);
});

test("page days are calendar days: a known day is that day, the table's order rolls December into January", () => {
  const rows = resolveRowDays([{ date: "12/26", status: null, seats: null, note: "", prices: [] }, { date: "1/2", status: null, seats: null, note: "", prices: [] }], [], NOW);
  assert.deepEqual(rows.map((entry) => entry.day), ["2098-12-26", "2099-01-02"]);
  assert.deepEqual(resolveRowDays([{ date: "1/9", status: null, seats: null, note: "", prices: [] }], ["2099-01-09"], NOW).map((entry) => entry.day), ["2099-01-09"]);
});

test("every difference for a day ahead, in day order, each with its line and the instruction for the assistant", () => {
  const items = compareWithTrip(NORVEL, rowsOf(TODAY), NOW).items;
  assert.deepEqual(items.map((item) => [item.kind, item.date]), [
    ["price", "2098-12-05"], ["seat_state", "2098-12-12"], ["price", "2098-12-12"], ["seat_count", "2098-12-19"], ["new_date", "2098-12-26"], ["gone_date", "2099-01-09"],
  ]);
  const [adult, seat, child, count, added, gone] = items;
  assert.equal(adult.text, "12/5: Том хүн 2,590,000₮ → 2,690,000₮");
  assert.equal(adult.instruction, "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» 12/5-ны том хүний үнийг 2,690,000 болго");
  assert.equal(seat.text, "12/12: Нээлттэй → Дүүрсэн");
  assert.ok(child.kind === "price" && child.fare === "child" && child.band === "Хүүхэд ор эзлэхгүй", "the no-bed column is the no-bed tier, named for set_date_price");
  assert.equal(child.instruction, "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» 12/12-ны хүүхдийн (Хүүхэд ор эзлэхгүй) үнийг 2,240,000 болго");
  assert.equal(count.text, "12/19: үлдсэн суудал 3 → 2 (цөөн суудал хэвээр)");
  assert.equal(count.instruction, "", "no write sets one day's seat count: shown without a button");
  assert.match(added.text, /^12\/26: хамтрагчийн хуудсанд шинэ гаралт \(Нээлттэй\) — Том хүн 3,190,000₮/);
  assert.equal(gone.instruction, "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» аяллын 1/9-ны гаралтыг хас");
});

test("«12 суудал үлдсэн» is not few seats; a day staff paused is theirs; a past day is not compared", () => {
  const page = pageText([
    ["12 суудал үлдсэн", "12 сарын 05", "12 сарын 12", "2,590,000 төг", "2,490,000 төг", "1,990,000 төг"],
    ["бүртгэж байна", "12 сарын 12", "12 сарын 19", "2,890,000 төг", "2,790,000 төг", "2,190,000 төг"],
    ["дүүрсэн", "11 сарын 01", "11 сарын 08", "1,000,000 төг", "1,000,000 төг", "1,000,000 төг"],
  ]);
  const paused = { ...NORVEL, extra: { ...NORVEL.extra, website_departure_availability: [
    { date: "2098-12-05", status: "OPEN", seatsLeft: null }, { date: "2098-12-12", status: "PAUSED", seatsLeft: null },
    { date: "2098-12-19", status: "PAUSED", seatsLeft: 3 }, { date: "2099-01-09", status: "PAUSED", seatsLeft: null },
  ] } };
  assert.deepEqual(compareWithTrip(paused, rowsOf(page), NOW).items, []);
});

test("seat changes applied without the admin only where set_date_state can write them", () => {
  const [seat] = compareWithTrip(NORVEL, rowsOf(TODAY), NOW).items.filter((item) => item.kind === "seat_state");
  if (seat.kind !== "seat_state") throw new Error("expected a seat change");
  assert.equal(seatChangeProblem(NORVEL, seat, NOW), null);
  assert.match(String(seatChangeProblem({ ...NORVEL, status: "draft" }, seat, NOW)), /идэвхтэй биш/);
  const offSite = { ...NORVEL, extra: { ...NORVEL.extra, website_departure_availability: [] } };
  assert.match(String(seatChangeProblem(offSite, seat, NOW)), /вэбсайтад хараахан нийтлэгдээгүй/);
  // Reopening a day whose price row was saved full would leave the fare card reading "conflict".
  const savedFull = { ...NORVEL, extra: { ...NORVEL.extra, price_groups: [row("2098-12-12", 2_890_000, 2_790_000, 2_190_000, { status: "sold_out" })] } };
  assert.match(String(seatChangeProblem(savedFull, { ...seat, to: { state: "open", seats: null }, from: { state: "full", seats: null } }, NOW)), /«дүүрсэн» гэж хадгалагдсан/);
});

test("hotels as column groups: each page group is compared with our row for that hotel", () => {
  const twoHotels = trip({
    id: "t-watch-hotels", route_name: "ТУРШИЛТ – ВЭЛМОР АРЛЫН АЯЛАЛ", departure_dates: ["2098-12-11"], adult_price: 1_990_000,
    extra: {
      source_url: URL,
      price_groups: [
        { dates: ["2098-12-11"], hotel: "Hotel Alpha Velmor", adult_price: 2_090_000, child_price: 1_590_000 },
        { dates: ["2098-12-11"], hotel: "Lumen Bay Resort", adult_price: 1_990_000, child_price: 1_590_000 },
      ],
      website_departure_availability: [{ date: "2098-12-11", status: "OPEN", seatsLeft: null }],
    },
  });
  const text = htmlToText(`<table>${td(["№", "Аялал гарах өдрүүд", "Том хүн 5 одтой<br>Hotel Alpha Velmor", "Хүүхэд 3-11 нас (Оргүй)<br>Hotel Alpha Velmor", "Том хүн 5 одтой<br>Lumen Bay Resort", "Хүүхэд 3-11 нас (Оргүй)<br>Lumen Bay Resort"])}${td(["1.", "12 сарын 11", "2,090,000", "1,590,000", "2,040,000", "1,590,000"])}</table>`).text;
  const items = compareWithTrip(twoHotels, rowsOf(text), NOW).items;
  assert.equal(items.length, 1, JSON.stringify(items));
  const [price] = items;
  assert.ok(price.kind === "price" && price.row_hotel === "Lumen Bay Resort" && price.from === 1_990_000 && price.to === 2_040_000);
  assert.equal(price.text, "12/11 (Lumen Bay Resort): Том хүн 5 одтой 1,990,000₮ → 2,040,000₮");
});

/* ---------------------------------------------------------------- */
/* The run                                                          */
/* ---------------------------------------------------------------- */

function fakes(trips: TravelTrip[], pages: Record<string, string | Error>, apply: (action: AITripAction) => { ok: boolean; message: string } = () => ({ ok: true, message: "Хадгалсан" })) {
  const fetched: string[] = [];
  const applied: AITripAction[] = [];
  const recorded: Array<Record<string, unknown>> = [];
  const deps: Partial<WatchDeps> = {
    loadTrips: async () => trips,
    lastChecked: async () => new Map(),
    fetchPage: async (url) => {
      fetched.push(url);
      const text = pages[url];
      if (text instanceof Error) throw text;
      return text === undefined ? { ok: false, url, error: "Хуудас 404 хариу өглөө (нээгдсэнгүй)." } : { ok: true, url, title: "Норвел", text, truncated: false, data_notice: "" };
    },
    applyAction: async (action) => { applied.push(action); return apply(action); },
    record: async (event) => { recorded.push(event as unknown as Record<string, unknown>); },
    now: () => NOW,
  };
  return { deps, fetched, applied, recorded };
}

test("a run: one fetch per page, seat states applied through set_date_state, everything else recorded", async () => {
  const twin = { ...NORVEL, id: "t-watch-norvel-2", route_name: "ТУРШИЛТ – НОРВЕЛ (ДАВХАР)", extra: { ...NORVEL.extra, source_url: "https://www.partner.example/tours/norvel/?utm_source=fb" } };
  const synced = { ...NORVEL, id: "t-watch-synced", extra: { ...NORVEL.extra, partner_sync: { source_url: URL } } };
  const archived: TravelTrip = { ...NORVEL, id: "t-watch-archived", status: "archived" };
  const { deps, fetched, applied, recorded } = fakes([NORVEL, twin, synced, archived], { [URL]: TODAY });
  const results = await runPartnerWatch({}, deps);
  assert.deepEqual(fetched, [URL], "one request for the page both trips were made from; the synced and the archived trip are not watched");
  assert.deepEqual(results.map((result) => [result.trip_id, result.status]), [["t-watch-norvel", "checked"], ["t-watch-norvel-2", "checked"]]);
  assert.equal(applied.length, 2, "the 12/12 seat state of each trip");
  assert.deepEqual(applied[0], {
    action: "set_date_state", trip_id: "t-watch-norvel", date: "2098-12-12", state: "full", observed_status: "OPEN", expected_updated_at: VERSION,
    summary: "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» — 12/12: Нээлттэй → Дүүрсэн (хамтрагчийн хуудсаар)",
  });
  assert.ok(applied.every((action) => action.action === "set_date_state"), "a price, a new or a vanished date is never written");
  assert.equal(recorded.length, 2);
  const event = recorded[0] as { ok: boolean; applied: Array<{ text: string }>; pending: Array<{ kind: string }>; source_url: string };
  assert.equal(event.ok, true);
  assert.equal(event.source_url, URL);
  assert.deepEqual(event.applied.map((line) => line.text), ["12/12: Нээлттэй → Дүүрсэн"]);
  assert.deepEqual(event.pending.map((item) => item.kind), ["price", "price", "seat_count", "new_date", "gone_date"]);
});

test("--dry-run reads and compares only: nothing applied, nothing recorded", async () => {
  const { deps, applied, recorded } = fakes([NORVEL], { [URL]: TODAY });
  const [result] = await runPartnerWatch({ dryRun: true }, deps);
  assert.equal(applied.length, 0);
  assert.equal(recorded.length, 0);
  assert.deepEqual(result.applied, [{ date: "2098-12-12", text: "12/12: Нээлттэй → Дүүрсэн", message: "dry-run: бичээгүй" }]);
});

test("failures are recorded, never thrown: an unreadable page, an unknown shape, a refused seat write", async () => {
  const other = { ...NORVEL, id: "t-watch-other", extra: { ...NORVEL.extra, source_url: "https://partner.example/tours/other" } };
  const third = { ...NORVEL, id: "t-watch-third", extra: { ...NORVEL.extra, source_url: "https://partner.example/tours/third" } };
  const { deps, recorded } = fakes([NORVEL, other, third], {
    [URL]: TODAY,
    "https://partner.example/tours/other": "<p>Энэ хуудсанд хуваарь алга.</p>",
    "https://partner.example/tours/third": new Error("socket hang up"),
  }, () => ({ ok: false, message: "«ТУРШИЛТ» энэ саналыг гаргаснаас хойш өөрчлөгдсөн байна" }));
  const results = await runPartnerWatch({}, deps);
  const byId = Object.fromEntries(results.map((result) => [result.trip_id, result]));
  assert.equal(byId["t-watch-other"].status, "failed");
  assert.equal(byId["t-watch-other"].error, "Хуудсанд гарах өдөр, үнэтэй хуваарийн хүснэгт олдсонгүй.");
  assert.equal(byId["t-watch-third"].status, "failed");
  assert.match(String(byId["t-watch-third"].error), /socket hang up/);
  const refused = byId["t-watch-norvel"].pending.find((item) => item.kind === "seat_state");
  assert.match(String(refused?.reason), /өөрчлөгдсөн байна/, "a refused write waits for the admin with the reason");
  assert.equal(recorded.length, 3);
  assert.deepEqual(recorded.map((event) => event.ok).sort(), [false, false, true]);
});

test("--trip names one trip; a trip the watch does not check says why", async () => {
  const synced = { ...NORVEL, id: "t-watch-synced", extra: { ...NORVEL.extra, partner_sync: { source_url: URL } } };
  const { deps, fetched } = fakes([synced], { [URL]: TODAY });
  const [result] = await runPartnerWatch({ tripId: "t-watch-synced" }, deps);
  assert.equal(result.status, "skipped");
  assert.match(String(result.error), /хамтрагчийн sync/);
  assert.deepEqual(fetched, []);
});
