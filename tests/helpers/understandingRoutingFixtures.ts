import type { FixtureTrip } from "./conversationGateHarness";

/** Invented-trip builder for the understanding-routing tests (every name and place here is made up). */
export const trip = (id: string, name: string, dates: string[], fares: [number, number, number | null], fields: Record<string, unknown> = {}) => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", adult_price: fares[0], child_price: fares[1], infant_price: fares[2],
  currency: "MNT", status: "active", duration_text: "8 өдөр 7 шөнө", departure_dates: dates, seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: name,
  extra: { customer_visible: true, age_rules: { adult: "12+ нас", child: "3-11 нас", infant: "0-23 сар" }, ...(fields.extra as object || {}) },
  ...Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "extra")),
} as unknown as FixtureTrip);

export const day = (n: number, title: string, description: string) => ({ day: n, title, description, meals: { breakfast: false, lunch: false, dinner: false } });

/** The sentinel text every Messenger send of a trip list carries: used to assert "no trip list was sent". */
export const TRIP_LIST_MARKERS = ["Аяллууд:", "Аль аяллыг"];

export const textOf = (sends: Array<{ text: string }>) => sends.map((send) => send.text).join("\n");
