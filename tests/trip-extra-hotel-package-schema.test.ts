// normalizeExtra keeps hotel profiles, hotel links, package options and every price-row field the
// website and the partner sync write. Names, links and fares are invented.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExtra, normalizeExtraPatch } from "../src/lib/tripExtraSchema";

type Row = Record<string, unknown>;

test("hotel profiles keep id, name, link, description, photos and stars; bad links and nameless profiles go with a warning", () => {
  const { extra, warnings } = normalizeExtra({ hotel_profiles: [
    { id: " h-norvel ", name: " Норвел Гранд ", url: " https://hotels.example.com/norvel ", description: " Тайлбар ", stars: 4,
      media: [{ url: "https://res.cloudinary.com/demo/image/upload/a.jpg", caption: " Усан сан " }, "https://res.cloudinary.com/demo/image/upload/b.jpg", { caption: "URL-гүй" }] },
    { name: "Таврин", url: "javascript:alert(1)", stars: 12 },
    { url: "https://hotels.example.com/nameless" },
    "not a profile",
  ] });
  assert.deepEqual(extra.hotel_profiles, [
    { id: "h-norvel", name: "Норвел Гранд", url: "https://hotels.example.com/norvel", description: "Тайлбар", stars: 4,
      media: [{ url: "https://res.cloudinary.com/demo/image/upload/a.jpg", caption: "Усан сан" }, { url: "https://res.cloudinary.com/demo/image/upload/b.jpg", caption: "" }] },
    { name: "Таврин", url: "", description: "", media: [] },
  ]);
  assert.ok(warnings.some((warning) => /Таврин.*холбоос/.test(warning)));
  assert.ok(warnings.some((warning) => /1 зураг/.test(warning)));
  assert.ok(warnings.some((warning) => /2 буудлын мэдээлэл нэргүй/.test(warning)));
  assert.ok(!warnings.some((warning) => /Үл мэдэгдэх.*hotel_profiles/.test(warning)), "hotel_profiles is a known key now");
});

test("hotel links and package options are kept in one shape", () => {
  const { extra, warnings } = normalizeExtra({
    hotel_links: [{ name: "Норвел Гранд", url: "https://hotels.example.com/norvel" }, { name: "Таврин" }, { url: "https://hotels.example.com/x" }],
    package_options: ["Багц А", { id: "Багц Б", label: "Б багц", note: " Өдөр бүр аялал " }, { label: "Багц В" }, { id: "Багц А" }, {}],
  });
  assert.deepEqual(extra.hotel_links, [{ name: "Норвел Гранд", url: "https://hotels.example.com/norvel" }]);
  assert.deepEqual(extra.package_options, [
    { id: "Багц А", label: "Багц А", note: "" },
    { id: "Багц Б", label: "Б багц", note: "Өдөр бүр аялал" },
    { id: "Багц В", label: "Багц В", note: "" },
  ]);
  assert.ok(warnings.some((warning) => /2 буудлын холбоос/.test(warning)));
  assert.ok(warnings.some((warning) => /2 багцын сонголт/.test(warning)));
});

test("hotel links and photos are https only, as the website, the bot and the AI catalogue read them", () => {
  const { extra, warnings } = normalizeExtra({
    hotel_profiles: [{ name: "Норвел Гранд", url: "http://hotels.example.com/norvel",
      media: ["http://res.cloudinary.com/demo/image/upload/a.jpg", { url: "https://res.cloudinary.com/demo/image/upload/b.jpg" }] }],
    hotel_links: [{ name: "Норвел Гранд", url: "http://hotels.example.com/norvel" }, { name: "Таврин", url: "https://hotels.example.com/tavrin" }],
  });
  const [profile] = extra.hotel_profiles as Row[];
  assert.equal(profile.url, "");
  assert.deepEqual(profile.media, [{ url: "https://res.cloudinary.com/demo/image/upload/b.jpg", caption: "" }]);
  assert.deepEqual(extra.hotel_links, [{ name: "Таврин", url: "https://hotels.example.com/tavrin" }]);
  assert.ok(warnings.some((warning) => /Норвел Гранд.*https биш/.test(warning)));
  assert.ok(warnings.some((warning) => /1 зураг https URL-гүй/.test(warning)));
  assert.ok(warnings.some((warning) => /1 буудлын холбоос нэр эсвэл https URL-гүй/.test(warning)));
});

test("a trip without hotel profiles, links or packages gets none, and a non-list is refused with a warning", () => {
  const plain = normalizeExtra({ aliases: ["x"] }).extra;
  for (const key of ["hotel_profiles", "hotel_links", "package_options"]) assert.equal(key in plain, false, key);
  const { extra, warnings } = normalizeExtra({ hotel_profiles: { name: "Норвел" } });
  assert.equal("hotel_profiles" in extra, false);
  assert.ok(warnings.some((warning) => /hotel_profiles жагсаалт биш/.test(warning)));
  // The save-time patch writes a list only when the save supplies it.
  assert.deepEqual(Object.keys(normalizeExtraPatch({ aliases: ["x"] })), ["aliases"]);
  assert.deepEqual(normalizeExtraPatch({ hotel_profiles: [] }), { hotel_profiles: [] });
});

test("price rows keep hotel, hotel identity, package, single-room price, availability and documented free fares", () => {
  const { extra } = normalizeExtra({ price_groups: [
    { dates: ["2099-06-12"], hotel: " Таврин ", hotel_id: " h-tavrin ", hotel_profile_ids: ["h-tavrin", "h-tavrin", ""], package_id: "Багц А",
      adult_price: 1_111_111, child_price: 0, infant_price: 0, child_price_free: true, infant_price_free: true, single_price: 611_111,
      status: "sold_out", seats_left: 0 },
    { dates: ["2099-06-19"], hotel: "Норвел", package: "Багц Б", adult_price: 1_222_222, child_price_free: "yes" },
    { dates: ["2099-06-26"], partner_source: true, adult_price: 1_333_333 },
  ] });
  const [first, second, partner] = extra.price_groups as Row[];
  assert.equal(first.hotel, "Таврин");
  assert.equal(first.hotel_id, "h-tavrin");
  assert.deepEqual(first.hotel_profile_ids, ["h-tavrin"]);
  assert.equal(first.package_id, "Багц А");
  assert.equal(first.single_price, 611_111);
  assert.equal(first.status, "sold_out");
  assert.equal(first.seats_left, 0);
  assert.equal(first.child_price_free, true);
  assert.equal(first.infant_price_free, true);
  // A row without availability or free-fare facts gains none.
  assert.equal(second.package_id, "Багц Б");
  for (const key of ["status", "seats_left", "child_price_free", "infant_price_free", "hotel_id", "hotel_profile_ids", "partner_source"]) assert.equal(key in second, false, key);
  // A partner row always states its availability, as before.
  assert.equal(partner.partner_source, true);
  assert.equal(partner.status, "");
  assert.equal(partner.seats_left, null);
});

test("legacy departure_date_groups keep passenger bands, hotel, package and single-room price", () => {
  const legacy = [{ dates: ["2099-06-12"], hotel: "Таврин", package_id: "Багц А", adult_price: 1_111_111, single_price: 611_111,
    passenger_prices: [{ label: "Хүүхэд", age_range: "2-5 нас", price: 911_111 }, { label: "Нярай", age_range: "0-2 нас", price: 0, note: "Үнэгүй" }] }];
  const alone = normalizeExtra({ departure_date_groups: legacy }).extra;
  for (const key of ["departure_date_groups", "price_groups"]) {
    const [group] = alone[key] as Row[];
    assert.equal(group.hotel, "Таврин", key);
    assert.equal(group.package_id, "Багц А", key);
    assert.equal(group.single_price, 611_111, key);
    assert.deepEqual((group.passenger_prices as Row[]).map((band) => [band.age_range, band.price, band.note]), [["2-5 нас", 911_111, ""], ["0-2 нас", 0, "Үнэгүй"]], key);
  }
  // Both keys present: price_groups stays canonical and the legacy rows keep their bands too.
  const both = normalizeExtra({ price_groups: [{ dates: ["2099-06-19"], adult_price: 1_222_222 }], departure_date_groups: legacy }).extra;
  assert.equal((both.price_groups as Row[]).length, 1);
  assert.equal(((both.departure_date_groups as Row[])[0].passenger_prices as Row[]).length, 2);
});
