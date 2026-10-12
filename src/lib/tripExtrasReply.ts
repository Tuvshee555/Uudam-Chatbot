import type { TravelTrip } from "./travelTypes";

// "Нэмэлт үзвэрийг заавал үзэх үү?": the customer asks about the add-ons, not the
// program. Without this the plan answered with the same program a second time.
const EXTRA_WORD = /нэмэлт|nemelt/iu;
const OPTION_WORD = /заавал|zaawal|zaaval|zavaal|үзэхгүй|uzehgvi|uzehgui|сонгох|сонголт|songolt|болох уу|boldog uu|боломжтой|шаардлагатай/iu;

/** A day's "Нэмэлт: <зүйл>: 300 юань/хүн" line, kept with the day it belongs to. */
function itineraryExtras(trip: TravelTrip): Array<{ day: number; text: string }> {
  const days = Array.isArray(trip.extra?.itinerary_days) ? trip.extra.itinerary_days : [];
  return days.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const day = typeof record.day === "number" ? record.day : index + 1;
    const description = typeof record.description === "string" ? record.description : "";
    return description.split(/\n+/).flatMap((line) => {
      const match = /^\s*нэмэлт\s*[:：]\s*(.+)$/iu.exec(line.trim());
      return match ? [{ day, text: match[1].trim() }] : [];
    });
  });
}

export function isOptionalExtrasQuestion(turn: string): boolean {
  return EXTRA_WORD.test(turn) && OPTION_WORD.test(turn);
}

/**
 * What the trip lists as add-ons, in its own words, and only that: whether one
 * is compulsory is not in the data, so the answer says so and sends the
 * customer to staff instead of guessing. Null when the trip lists no add-ons.
 */
export function buildOptionalExtrasReply(trip: TravelTrip, turn: string): string | null {
  if (!isOptionalExtrasQuestion(turn)) return null;
  const extras = itineraryExtras(trip);
  if (!extras.length) return null;
  return [
    `✈️ ${trip.route_name}`,
    "Хөтөлбөрт заасан нэмэлт үзвэр, үйлчилгээ:",
    ...extras.map((extra) => `• ${extra.day}-р өдөр: ${extra.text}`),
    "",
    "Эдгээр нь тус тусын үнэтэй нэмэлт. Заавал үзэх эсэх нь хөтөлбөрт тодорхой бичигдээгүй тул аяллын зөвлөхөөс баталгаажуулж өгнө.",
  ].join("\n");
}
