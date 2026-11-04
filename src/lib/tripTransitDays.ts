/**
 * The standard first and last days of a trip, by how it leaves Ulaanbaatar.
 *
 * Owner's rule (docs/trip-import-playbook.md, 2026-10-14 and 10-17): every trip
 * that leaves by the overnight train to Zamyn-Uud — land, land+flight, and the
 * cruises that sail from a Chinese port — starts with the 16:40 train day,
 * crosses back through Erenhot and ends on the morning it arrives in
 * Ulaanbaatar; a partner's program that begins at the border gains two days and
 * two nights. A trip that flies out of Ulaanbaatar never gets a train day.
 * Until 2026-11-04 nothing in code did this: the days were typed by hand, and a
 * partner's Word program could not be saved at all (the save check needs the
 * trip to start and end in Ulaanbaatar).
 *
 * The generated days are recognised by their exact wording, so rebuilding for
 * another transport type replaces them instead of stacking a second set.
 */
import { itineraryEndsInUlaanbaatar, itineraryStartsInUlaanbaatar } from "./tripItineraryBoundaries";

export type TransportType = "land" | "land_flight" | "direct_flight" | "cruise";
/** The proposal conflict item that carries a new trip's transport choice (tripProposalFinalize.ts). */
export const TRANSPORT_CHOICE = "transport_choice";
export const TRANSPORT_TYPES: readonly TransportType[] = ["land", "land_flight", "direct_flight", "cruise"];
export const TRANSPORT_LABELS: Record<TransportType, string> = {
  land: "Газраар — галт тэрэг, автобус",
  land_flight: "Газар + нислэг хосолсон",
  direct_flight: "Улаанбаатараас шууд нислэгээр",
  cruise: "Усан онгоцны аялал",
};
/** What the website lists under "Тээвэр" for each type. */
export const TRANSPORT_WEBSITE_TAGS: Record<TransportType, string[]> = {
  land: ["Галт тэрэг", "Автобус"],
  land_flight: ["Галт тэрэг", "Онгоц"],
  direct_flight: ["Онгоц"],
  cruise: ["Галт тэрэг", "Усан онгоц"],
};

export type ItineraryDay = {
  day?: number;
  title?: string;
  description?: string;
  hotel?: string;
  photo?: string;
  meals?: { breakfast?: boolean; lunch?: boolean; dinner?: boolean };
};

export const STANDARD_DAYS = {
  departure: {
    title: "УЛААНБААТАР – ЗАМЫН ҮҮД",
    description: "УБ - Замын Үүд чиглэлийн галт тэрэг 16:40-д хөдлөх бөгөөд 1 цагийн өмнө галт тэрэгний буудал дээр цуглана.",
  },
  /** Opens the partner's first day: the train arrives, the bus crosses the border. */
  borderInbound: "Өглөө 07:20 цагт Замын Үүдэд буугаад автобусанд сууж хил гаалиар нэвтэрнэ. Эрээн хотод ирнэ.",
  /** A day of its own when the program spends its last night in Erenhot. */
  borderOutbound: {
    title: "ЭРЭЭН – ЗАМЫН ҮҮД",
    description: "Өглөөний цай.\n12.00 цагт хил гаалиар гарч Замын-Үүдэд ирнэ.\n18.00 цагт хөдлөх Замын-Үүд УБ чиглэлийн галт тэргэнд сууна.",
  },
  /** Closes a partner's last day that already reaches Erenhot that day. */
  borderOutboundSameDay: "Эрээнд ирээд хил гаалиар гарч Замын-Үүдэд ирнэ.\n18.00 цагт хөдлөх Замын-Үүд УБ чиглэлийн галт тэргэнд сууна.",
  arrival: {
    title: "УЛААНБААТАР ХОТ",
    description: "Өглөө 09.20 цагт Улаанбаатарт ирснээр манай аялал өндөрлөнө.",
  },
  flightDeparture: "Аялагчид Чингис Хаан олон улсын нисэх буудалд цуглана.",
  flightArrival: "Улаанбаатар хотод ирснээр манай аялал өндөрлөнө.",
} as const;

const CRUISE = /усан онгоц|круиз|cruise|каюта|caбин|cabin/i;
// No \b here: a JS word boundary never fires before a Cyrillic letter.
const FLIGHT = /нис|онгоц|airport|flight|хөөрнө|газардана/i;
const TRAIN_OR_LAND = /галт тэрэг|замын[ -]?үүд|эрээн|erenhot|zamyn|автобус|газраар|газрын|хил гаал/i;
const UB_AIRPORT = /чингис\s*хаан|улаанбаатар(?:аас|ын)?[^.]{0,40}нис|нис[^.]{0,40}улаанбаатар/i;
const ERENHOT = /эрээн|erenhot/i;

const text = (value: unknown) => (typeof value === "string" ? value : "").trim();
const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
const dayText = (day: ItineraryDay | undefined) => `${text(day?.title)} ${text(day?.description)}`;

export function isTransportType(value: unknown): value is TransportType {
  return typeof value === "string" && (TRANSPORT_TYPES as readonly string[]).includes(value);
}

/**
 * How the trip leaves Ulaanbaatar, read from the program itself. `sure` is false
 * when it is a guess the admin should confirm (the proposal offers the choice).
 */
export function detectTransportType(input: {
  title?: string; route?: string; notes?: string; days?: ItineraryDay[]; transportType?: unknown; transport?: unknown;
}): { transport: TransportType; sure: boolean } {
  if (isTransportType(input.transportType)) return { transport: input.transportType, sure: true };
  const days = input.days || [];
  const head = `${text(input.title)} ${text(input.route)}`;
  const first = dayText(days[0]);
  const body = days.map(dayText).join("\n");
  const everything = `${head}\n${body}\n${text(input.notes)}\n${Array.isArray(input.transport) ? input.transport.join(" ") : ""}`;
  if (CRUISE.test(head)) return { transport: "cruise", sure: true };
  if (CRUISE.test(everything)) return { transport: "cruise", sure: false };
  if (UB_AIRPORT.test(first) && !TRAIN_OR_LAND.test(first)) return { transport: "direct_flight", sure: true };
  const landStart = TRAIN_OR_LAND.test(first) || ERENHOT.test(first);
  const flightInside = FLIGHT.test(days.slice(1).map(dayText).join("\n")) || (landStart && FLIGHT.test(first));
  if (landStart) return { transport: flightInside ? "land_flight" : "land", sure: true };
  if (/шууд нислэг/i.test(head)) return { transport: "direct_flight", sure: true };
  if (TRAIN_OR_LAND.test(everything)) return { transport: FLIGHT.test(everything) ? "land_flight" : "land", sure: false };
  if (FLIGHT.test(first)) return { transport: "direct_flight", sure: false };
  return { transport: "land", sure: false };
}

/** The days without any day this module generated, so a rebuild starts from the program itself. */
export function stripStandardTransitDays(days: ItineraryDay[]): ItineraryDay[] {
  const kept = days.filter((day) => {
    const title = text(day.title), description = text(day.description);
    if (same(title, STANDARD_DAYS.departure.title) && same(description, STANDARD_DAYS.departure.description)) return false;
    if (same(title, STANDARD_DAYS.borderOutbound.title) && same(description, STANDARD_DAYS.borderOutbound.description)) return false;
    if (same(title, STANDARD_DAYS.arrival.title) && same(description, STANDARD_DAYS.arrival.description)) return false;
    return true;
  });
  return kept.map((day) => {
    let description = text(day.description);
    let title = text(day.title);
    if (description.startsWith(STANDARD_DAYS.borderInbound)) {
      description = description.slice(STANDARD_DAYS.borderInbound.length).replace(/^\s*\n?/, "");
      title = title.replace(/^ЗАМЫН ҮҮД – /, "");
    }
    if (description.endsWith(STANDARD_DAYS.borderOutboundSameDay)) description = description.slice(0, -STANDARD_DAYS.borderOutboundSameDay.length).replace(/\s*\n?$/, "");
    if (description.startsWith(STANDARD_DAYS.flightDeparture)) description = description.slice(STANDARD_DAYS.flightDeparture.length).trim();
    if (description.endsWith(STANDARD_DAYS.flightArrival)) description = description.slice(0, -STANDARD_DAYS.flightArrival.length).trim();
    return { ...day, title, description };
  });
}

const meals = (breakfast = false) => ({ breakfast, lunch: false, dinner: false });

/**
 * The program with the standard first and last days for `transport`. Days the
 * program already has in Ulaanbaatar are kept as written. `added` counts the
 * days put in front of or after the program (the duration grows by as many).
 */
export function withStandardTransitDays(input: ItineraryDay[], transport: TransportType): { days: ItineraryDay[]; added: number } {
  const days = stripStandardTransitDays(input).map((day) => ({ ...day }));
  if (!days.length) return { days: [], added: 0 };
  let added = 0;
  if (transport === "direct_flight") {
    if (!itineraryStartsInUlaanbaatar(days[0])) days[0].description = `${STANDARD_DAYS.flightDeparture} ${text(days[0].description)}`.trim();
    const last = days[days.length - 1];
    if (!itineraryEndsInUlaanbaatar(last)) last.description = `${text(last.description)} ${STANDARD_DAYS.flightArrival}`.trim();
  } else {
    if (!itineraryStartsInUlaanbaatar(days[0])) {
      const first = days[0];
      first.description = `${STANDARD_DAYS.borderInbound}\n${text(first.description)}`.trim();
      if (!/замын/i.test(text(first.title))) first.title = `ЗАМЫН ҮҮД – ${text(first.title)}`.trim();
      days.unshift({ ...STANDARD_DAYS.departure, meals: meals() });
      added += 1;
    }
    const last = days[days.length - 1];
    if (!itineraryEndsInUlaanbaatar(last)) {
      if (ERENHOT.test(dayText(last))) {
        last.description = `${text(last.description)}\n${STANDARD_DAYS.borderOutboundSameDay}`.trim();
      } else {
        days.push({ ...STANDARD_DAYS.borderOutbound, meals: meals(true) });
        added += 1;
      }
      days.push({ ...STANDARD_DAYS.arrival, meals: meals() });
      added += 1;
    }
  }
  return { days: days.map((day, index) => ({ ...day, day: index + 1 })), added };
}

/** Door-to-door duration: every day counts, the train nights included. */
export function durationForDays(count: number): { duration_days: number; duration_nights: number; duration_text: string } {
  const nights = Math.max(0, count - 1);
  return { duration_days: count, duration_nights: nights, duration_text: `${count} өдөр ${nights} шөнө` };
}

/** True for a day this module wrote (no photo belongs on it). */
export function isTransitDay(day: ItineraryDay): boolean {
  const title = text(day.title);
  return [STANDARD_DAYS.departure.title, STANDARD_DAYS.borderOutbound.title, STANDARD_DAYS.arrival.title].some((standard) => same(title, standard));
}
