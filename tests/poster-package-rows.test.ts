import assert from "node:assert/strict";
import test from "node:test";
import { splitPackagedHotel, splitPackagedHotelRows } from "../src/lib/poster/packageRows";

const PACKAGES = [{ id: "Хөтөлбөртэй", label: "Хөтөлбөртэй", note: "" }, { id: "Хөтөлбөргүй", label: "Хөтөлбөргүй", note: "" }];

test("a poster 'Hotel · Package' cell splits only against the trip's own packages", () => {
  assert.deepEqual(splitPackagedHotel("Туршилт Буудал · Хөтөлбөртэй", PACKAGES), { hotel: "Туршилт Буудал", packageId: "Хөтөлбөртэй" });
  assert.equal(splitPackagedHotel("Туршилт Буудал · Далайн харагдацтай", PACKAGES), null, "a right side that is not a package stays part of the name");
  assert.equal(splitPackagedHotel("Туршилт Буудал", PACKAGES), null);
});

test("a poster save keeps hotel and package apart and the row facts the poster does not hold", () => {
  const existing = {
    package_options: PACKAGES,
    hotel_profiles: [{ id: "h-alpha", name: "Alpha Resort Testville" }],
    price_groups: [
      { hotel: "Alpha", package_id: "Хөтөлбөртэй", dates: ["2031-03-04"], status: "sold_out", seats_left: 0, partner_source: true },
    ],
  };
  const rows = splitPackagedHotelRows<Record<string, unknown>>([
    { hotel: "Alpha · Хөтөлбөртэй", dates: ["2031-03-04"], adult_price: 1_000_000 },
    { hotel: "Alpha · Хөтөлбөргүй", dates: ["2031-03-04"], adult_price: 900_000 },
    { hotel: "Beta", dates: ["2031-03-04"], adult_price: 800_000 },
  ], existing);
  assert.deepEqual(rows[0], {
    hotel: "Alpha", package_id: "Хөтөлбөртэй", dates: ["2031-03-04"], adult_price: 1_000_000,
    hotel_id: "h-alpha", hotel_profile_ids: ["h-alpha"], status: "sold_out", seats_left: 0, partner_source: true,
  });
  assert.equal(rows[1].package_id, "Хөтөлбөргүй");
  assert.equal("status" in rows[1], false, "no matching stored row, nothing invented");
  assert.deepEqual(rows[2], { hotel: "Beta", dates: ["2031-03-04"], adult_price: 800_000 });
});

test("a trip with no package list is left exactly as the poster says", () => {
  const groups = [{ hotel: "Alpha · Хөтөлбөртэй", dates: ["2031-03-04"] }];
  assert.equal(splitPackagedHotelRows(groups, {}), groups);
});
