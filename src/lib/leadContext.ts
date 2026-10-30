import type { TravelTrip } from "./travelTypes";

type Turn = { role: "user" | "assistant"; text: string };

/**
 * What the conversation already established, written on a lead so staff can act
 * on it without scrolling the chat: the trip the customer picked (or the trips
 * just offered) and the customer's last few messages. A lead used to say only
 * "Чатад утасны дугаараа үлдээсэн." even after the customer had named a
 * destination and asked about it (live replay 2026-10-30).
 */
export function conversationLeadContext(input: {
  history: Turn[];
  currentText: string;
  selectedTrip?: TravelTrip | null;
  shownTrips?: TravelTrip[];
}): string {
  const lines: string[] = [];
  if (input.selectedTrip) lines.push(`Сонгосон аялал: ${input.selectedTrip.route_name}`);
  else if (input.shownTrips?.length) lines.push(`Сүүлд санал болгосон: ${input.shownTrips.slice(0, 3).map((trip) => trip.route_name).join("; ")}`);
  // The number itself is already on the lead; a phone-only message adds nothing here.
  const asked = [...input.history.filter((turn) => turn.role === "user").map((turn) => turn.text), input.currentText]
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter((text) => text && !/^[\d\s+()-]{8,}$/.test(text))
    .slice(-4);
  if (asked.length) lines.push(`Сүүлийн мессежүүд: ${asked.map((text) => text.slice(0, 120)).join(" / ")}`);
  return lines.join("\n");
}
