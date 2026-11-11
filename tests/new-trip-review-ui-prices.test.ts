/**
 * The price part of the new-trip review as the admin sees it (server-rendered markup): one section
 * under the calendar, days with the same price in one card, adult and child red while empty, the
 * infant optional, and none of the old duplicate controls. Routes, hotels, prices and dates are
 * invented; the dates are far ahead so they are never "past".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewTripReview } from "../src/components/admin/tripReview/NewTripReview";
import { PriceSection } from "../src/components/admin/tripReview/PriceSection";
import { weekdayOf } from "../src/lib/tripReview";

type Row = Record<string, unknown>;
const noop = () => undefined;
const [D1, D2, D3] = ["2098-05-08", "2098-05-15", "2098-05-22"];
const wd = (ymd: string) => weekdayOf(ymd).slice(0, 2);

const row = (dates: string[], adult: number | null, child: number | null, more: Row = {}): Row => ({
  label: "", dates, adult_price: adult, child_price: child, infant_price: null, note: "",
  passenger_prices: child === null ? [] : [{ label: "Хүүхэд", age_range: "", price: child, currency: "MNT" }],
  ...more,
});
const trip = (dates: string[], groups: Row[], base: Row = {}): Row => ({
  route_name: "ВЭЛМОР НУУРЫН АЯЛАЛ", duration_text: "3 өдөр 2 шөнө", departure_dates: dates, adult_price: null, child_price: null, infant_price: null,
  photo_urls: [], extra: { price_groups: groups, itinerary_days: [], included_items: ["Нислэгийн тийз, буудал, өглөөний цай, хөтчийн үйлчилгээ, даатгал багтсан"] }, ...base,
});
const review = (fields: Row) => renderToStaticMarkup(createElement(NewTripReview, { fields, onChange: noop, warnings: [] }));
const section = (fields: Row) => renderToStaticMarkup(createElement(PriceSection, { fields, onChange: noop }));
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("the review has ONE price section under the calendar: no flat box beside a vague link to another editor", () => {
  for (const fields of [trip([D1, D2], []), trip([D1, D2], [row([D1], 2190000, 1890000), row([D2], 2390000, 2090000)])]) {
    const text = plain(review(fields));
    assert.ok(text.includes("Гарах өдөр ба үнэ"), "calendar and prices are one group");
    assert.equal(text.includes("Гаралт тус бүрээр үнэ оруулах"), false, "the vague link is gone");
    assert.equal(text.includes("Гаралт нэмэх"), false, "so is the second editor's add button");
    assert.equal(text.includes("Гаралт ба үнэ"), false);
    assert.equal(text.includes("Гарах огноо сонгох"), false, "and its date picker");
    assert.ok(text.indexOf("Сонгосон") < text.indexOf("Нэг хүний, төгрөгөөр"), "the prices come after the calendar");
  }
});

test("days with the same price are one card listing them; a different price is another card", () => {
  const html = section(trip([D1, D2, D3], [row([D1], 2190000, 1890000), row([D2], 2390000, 2090000), row([D3], 2190000, 1890000)], { adult_price: 2190000, child_price: 1890000 }));
  const text = plain(html);
  assert.equal((html.match(/<section /g) || []).length, 2, "two cards for three days");
  assert.ok(text.includes(`5/8 ${wd(D1)} 5/22 ${wd(D3)}`), "the two days of one price side by side");
  assert.ok(text.includes("2 өдөр"));
  assert.ok(html.includes(`aria-label="5/8 ${wd(D1)}, 5/22 ${wd(D3)} — Том хүн 2,190,000₮ · Хүүхэд 1,890,000₮"`), "a card reads as one line of dates and fares");
  assert.equal((text.match(new RegExp(`5/8 ${wd(D1)}`, "g")) || []).length, 1, "a day is written in one card");
  assert.ok(text.includes("«эхлэх үнэ» 2,190,000₮"), "the website's «from» price");
  assert.ok(html.includes('value="2,190,000"') && html.includes('value="2,390,000"'));
  assert.ok(text.includes("Өдөр салгах эсвэл шилжүүлэх"), "a card of two days can be split");
});

test("no price rows: one card for all days; «Энэ огнооны үнэ өөр бол…» is the one action to give a day its own price", () => {
  const html = section(trip([D1, D2, D3], [], { adult_price: 3290000, child_price: 2590000 }));
  const text = plain(html);
  assert.equal((html.match(/<section /g) || []).length, 1);
  assert.ok(text.includes("Бүх гарах өдөр · 3 өдөр"));
  assert.ok(text.includes("Энэ огнооны үнэ өөр бол…"));
  assert.equal(text.includes("Тусдаа үнийг болих"), false, "nothing to undo yet");
  // One day: nothing to split.
  assert.equal(plain(section(trip([D1], [], { adult_price: 3290000, child_price: 2590000 }))).includes("Энэ огнооны үнэ өөр бол"), false);
});

test("adult and child are required and red while empty; the infant is optional; a complete card has no red", () => {
  const empty = section(trip([D1, D2], [], { adult_price: 3290000 }));
  assert.ok(empty.includes('aria-invalid="true"'), "the empty child box is invalid");
  assert.equal((empty.match(/aria-invalid="true"/g) || []).length, 1, "only the child box: the adult fare is there");
  assert.ok(/text-danger[^"]*">Дутуу</.test(empty), "its label says missing, in red");
  assert.ok(empty.includes("border-danger"));
  const text = plain(empty);
  assert.ok(text.includes("Том хүн, хүүхдийн үнэ заавал."));
  assert.ok(text.includes("Үнэгүйгээр ноорог хадгалж болно"), "a draft needs neither");
  assert.ok(text.includes("Нярайн үнэ заавал биш"));
  const none = section(trip([D1], []));
  assert.equal((none.match(/aria-invalid="true"/g) || []).length, 2, "nothing entered: adult and child");
  const complete = section(trip([D1, D2], [], { adult_price: 3290000, child_price: 2590000 }));
  assert.equal(complete.includes("aria-invalid"), false);
  assert.equal(complete.includes("border-danger"), false);
  assert.equal(plain(complete).includes("Том хүн, хүүхдийн үнэ заавал."), false, "no red notice once both are there");
});

test("a card for days that already left is not asked for its fares, and says so", () => {
  const html = section(trip(["2000-01-05", D1], [row(["2000-01-05"], 1990000, null), row([D1], 2190000, 1890000)]));
  assert.equal(html.includes("aria-invalid"), false);
  assert.ok(plain(html).includes("Өнгөрсөн"));
});

test("a day added later shows as «Үнэ оруулаагүй» in the «Бусад өдөр» card, empty and red", () => {
  const fields = trip([D1, D2, D3], [row([D1], 2190000, 1890000), row([D2], 2390000, 2090000)]);
  const html = section(fields);
  const text = plain(html);
  assert.ok(text.includes("Бусад өдөр"));
  assert.ok(text.includes("Үнэ оруулаагүй"));
  assert.ok(text.includes(`5/22 ${wd(D3)}`));
  assert.equal((html.match(/aria-invalid="true"/g) || []).length, 2, "adult and child of the unpriced day");
  assert.ok(text.includes("Тусдаа үнэ"), "the others are named as having their own price");
});

test("a card's hotel, package and single-room extra sit behind one summary; infant «Үнэгүй» is a checkbox", () => {
  const html = section(trip([D1], [row([D1], 2190000, 1890000, { hotel: "Норвел 4*", package_id: "Хөтөлбөртэй" })]));
  const text = plain(html);
  assert.ok(text.includes("Норвел 4* · Хөтөлбөртэй"), "the card is named by its hotel and package");
  assert.ok(text.includes("Буудал, багц, ганц өрөө, тэмдэглэл"));
  assert.ok(html.includes("<details") && html.includes(" open"), "open when the row already has a hotel");
  assert.ok(text.includes("Холбоос, зургийг доорх «Зочид буудлууд»-д нэмнэ."), "the hint names the section that exists in the review");
  assert.ok(text.includes("Үнэгүй"));
});

test("the file's second child tier shows as an extra row under a heading that says what it is", () => {
  const html = section(trip([D1], [row([D1], 2190000, 1890000, { passenger_prices: [
    { label: "Хүүхэд", age_range: "", price: 1890000, currency: "MNT" },
    { label: "Хүүхэд ор эзлэхгүй", age_range: "", price: 1500000, currency: "MNT" },
  ] })]));
  assert.ok(plain(html).includes("Өөр ангиллын үнэ"));
  assert.ok(html.includes('value="Хүүхэд ор эзлэхгүй"') && html.includes('value="1,500,000"'));
  assert.ok(html.includes('value="1,890,000"'), "the child fare keeps its own box");
});

test("the rest of the review: whole facts instead of cut-off lines, one name for each website text, the bot's terms say so", () => {
  const html = review(trip([D1], [], { adult_price: 3290000, child_price: 2590000 }));
  const text = plain(html);
  assert.ok(/<textarea[^>]*aria-label="Үнэд багтсан 1"/.test(html), "a long line of what the price includes is shown whole");
  assert.equal(/<input[^>]*aria-label="Үнэд багтсан 1"/.test(html), false);
  assert.ok(text.includes("Бүртгэлийн нөхцөл") && text.includes("Бот «урьдчилгаа хэд вэ?»"));
  assert.ok(text.includes("Картанд гарах товч") && text.includes("Хуудсанд гарах тайлбар"));
  assert.equal(text.includes("Тэмдэглэл заавал биш"), false, "the old vague «Тэмдэглэл» box");
  assert.ok(text.includes("Насны ангилал"), "age bands sit beside the prices they describe");
  assert.ok(text.indexOf("Нэг хүний, төгрөгөөр") < text.indexOf("Насны ангилал"));
});

test("what stops a publish or a save is said beside its field: no departure day, an empty name, a program that cannot be switched", () => {
  const html = review({ ...trip([], []), route_name: "" });
  const text = plain(html);
  assert.ok(text.includes("Гарах өдөр сонгоогүй. Нийтлэхийн тулд календариас дор хаяж нэг өдөр сонгоно уу. Ноорог болгон хадгалж болно."), "the calendar says it needs a day");
  assert.ok(/id="review-route-name"[^>]*aria-invalid="true"/.test(html) || /aria-invalid="true"[^>]*id="review-route-name"/.test(html), "an empty name blocks every save: red");
  assert.ok(text.includes("Хөтөлбөр алга тул тээврийг сонгох боломжгүй."), "a transport switch that cannot work says why");
  const fine = plain(review(trip([D1], [], { adult_price: 3290000, child_price: 2590000 })));
  assert.equal(fine.includes("Нийтлэхийн тулд календариас"), false);
});
