/**
 * "Хэдэн цагт нисэх вэ" asks for a CLOCK TIME of a travel leg. The only source for it is the trip's
 * own itinerary ("УБ хотоос 13:00 цагт нисээд 16:45 цагт ... буулна"). A transport category label
 * ("Шууд нислэгтэй аялал") says nothing about the hour, and was sent as the answer to this question
 * (real case 16, 2026-11-02). With no clock time in the itinerary the question has no answer: the
 * answer plan hands it to staff (silence plus a lead).
 */
import type { TravelTrip } from "./travelTypes";
import { normText } from "./travelTextNorm";

/** "what time" in Cyrillic and Latin spellings; "хэзээ цагт" / "hezhe tsagt" ("when, at what hour") too. */
const WHAT_TIME = /(?:^|\s)(?:(?:хэдэн|хэд|ямар|хэдийн)\s+цаг(?:т|ийн|аар|ийг)?|хэзээ\s+цагт|цаг\s+хэд|цагийн\s+хуваарь|(?:heden|hed|hedn|yamar|hediin)\s+ts?ag(?:t|iin|aar)?|(?:hezee|hezhe|hejee|hezii|xezee)\s+ts?agt|ts?ag\s+hed|tsagiin\s+huvaari)(?=\s|$)/u;
/** A travel leg: fly, take off, land, depart, start, train, bus. */
const LEG_WORD = /(?:^|\s)(?:нис[\p{L}]*|онгоц[\p{L}]*|хөөр[\p{L}]*|буух|буулт[\p{L}]*|газарда[\p{L}]*|хөдл[\p{L}]*|эхл[\p{L}]*|гарах|гарна|тэрэг[\p{L}]*|автобус[\p{L}]*|nis[\p{L}]*|ongots[\p{L}]*|huur[\p{L}]*|huurnu|buuh|hudul[\p{L}]*|ehel[\p{L}]*|ehl[\p{L}]*|garah|garna|tereg[\p{L}]*|avtobus[\p{L}]*)(?=\s|$)/u;
/** A question about meeting before the trip (airport, station) is not a question about a leg. */
const MEETING = /(?:^|\s)(?:буудал[\p{L}]*|buudal[\p{L}]*|уулз[\p{L}]*|цуглар[\p{L}]*|цугл[\p{L}]*|uulz[\p{L}]*|tsugl[\p{L}]*)(?=\s|$)/u;

export function asksClockTime(text: string): boolean {
  const said = normText(text);
  return WHAT_TIME.test(said) && LEG_WORD.test(said) && !MEETING.test(said);
}

const CLOCK = /(?:^|[^\d])(?:[01]?\d|2[0-3])[:.][0-5]\d(?!\d)/u;
const FLIGHT = /нис|онгоц|хөөр|газарда|буу(?:н|л)|flight|nis|ongots/iu;
const TRAIN = /тэрэг|tereg/iu;
const BUS = /автобус|avtobus/iu;
const ANY_LEG = /нис|онгоц|хөөр|газарда|буу(?:н|л)|тэрэг|автобус|хөдл|гарна|эхэл|ирнэ|очно|хүрнэ/iu;

const records = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object") : [];

/**
 * The itinerary sentences that state a clock time of the kind of leg asked about, with their day
 * number; null when the itinerary holds none (then nothing may be said).
 */
export function scheduleTimeSection(trip: TravelTrip, question: string): string | null {
  const said = normText(question);
  const wanted = FLIGHT.test(said) ? FLIGHT : TRAIN.test(said) ? TRAIN : BUS.test(said) ? BUS : ANY_LEG;
  const lines: string[] = [];
  records(trip.extra?.itinerary_days).forEach((day, index) => {
    const number = typeof day.day === "number" ? day.day : index + 1;
    const text = [day.route, day.title, day.summary, day.description].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join(". ");
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/u)) {
      const part = sentence.trim();
      if (part && CLOCK.test(part) && wanted.test(part)) lines.push(`${number}-р өдөр: ${part.replace(/\s+/g, " ")}`);
    }
  });
  const unique = [...new Set(lines)].slice(0, 4);
  return unique.length ? unique.join("\n") : null;
}
