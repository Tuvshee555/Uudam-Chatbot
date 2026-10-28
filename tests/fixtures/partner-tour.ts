import type { PartnerPrices, PartnerRow, PartnerTour } from "../../src/lib/partnerSync/globalTravel";
export const prices = (overrides: Partial<PartnerPrices> = {}): PartnerPrices => ({
  adult: 2100000, child2to5: 1200000, child6to11: 1600000, infant: 320000, single: 520000,
  programAdult: 2400000, programChild2to5: 1300000, programChild6to11: 1900000, ...overrides,
});
export const row = (date = "2099-06-12", hotel = "Example Bay", overrides: Partial<PartnerRow> = {}): PartnerRow =>
  ({ date, hotel, open: true, seats: 24, prices: prices(), ...overrides });
export const tour = (rows = [row(), row("2099-06-19", "Example Garden", { prices: prices({ adult: 2600000, infant: 340000, single: 620000 }) })]): PartnerTour => ({
  slug: "sample-tour", sourceUrl: "https://example.com/tours/sample-tour", title: "Example coast tour",
  description: "Sample description", destinations: ["Example Coast"], airlines: ["Example Air"],
  durationDays: 2, durationNights: 1,
  hotels: [{ name: "Example Bay", stars: 4, description: "Example hotel description" }],
  includes: ["Breakfast"], excludes: ["Personal expenses"],
  days: [
    { day: 1, title: "Arrival", route: "Example Port - Example Coast", lines: ["Gather at the airport", "12:30 нислэг"], meals: { breakfast: true, lunch: false, dinner: false }, accommodation: "Example Bay", distance: "120 км" },
    { day: 2, title: "Return", route: "", lines: ["Return journey"], meals: { breakfast: true, lunch: false, dinner: false }, accommodation: null },
  ],
  rows, dates: [...new Set(rows.map((r) => r.date))], hotelOptions: [...new Set(rows.map((r) => r.hotel))],
  updatedAt: null, contentHash: "sample-hash",
});
