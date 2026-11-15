/**
 * The price part of the new-trip review as the admin sees it (server-rendered markup): one table
 * under the dates, days with the same price in one row, adult and child red while empty, the infant
 * optional, and none of the old duplicate controls. A row opens its editor in place (the row's boxes
 * are rendered with `openCard`). Routes, hotels, prices and dates are invented; the dates are far
 * ahead so they are never "past". Since 2026-11-11 the review is a preview (tests/new-trip-review-preview.test.ts).
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
const review = (fields: Row, initialOpen?: string) => renderToStaticMarkup(createElement(NewTripReview, { fields, onChange: noop, warnings: [], initialOpen }));
const section = (fields: Row, openCard?: string) => renderToStaticMarkup(createElement(PriceSection, { fields, onChange: noop, ...(openCard ? { openCard, onOpenCard: noop } : {}) }));
const rows = (html: string) => (html.match(/data-price-row="/g) || []).length;
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("the review has ONE price table under the dates: no flat box beside a vague link to another editor", () => {
  for (const fields of [trip([D1, D2], []), trip([D1, D2], [row([D1], 2190000, 1890000), row([D2], 2390000, 2090000)])]) {
    const text = plain(review(fields));
    assert.ok(text.includes("Гарах өдөр ба үнэ"), "calendar and prices are one group");
    assert.equal(text.includes("Гаралт тус бүрээр үнэ оруулах"), false, "the vague link is gone");
    assert.equal(text.includes("Гаралт нэмэх"), false, "so is the second editor's add button");
    assert.equal(text.includes("Гаралт ба үнэ"), false);
    assert.equal(text.includes("Гарах огноо сонгох"), false, "and its date picker");
    assert.ok(text.indexOf("Огноо нэмэх, хасах") < text.indexOf("Нэг хүний үнэ, төгрөгөөр"), "the dates' button comes before the prices");
    const open = plain(review(fields, "calendar"));
    assert.ok(open.indexOf("Сонгосон") > 0 && open.indexOf("Сонгосон") < open.indexOf("Нэг хүний үнэ, төгрөгөөр"), "the calendar, once open, sits above the prices");
  }
});

test("days with the same price are one row listing them; a different price is another row", () => {
  const fields = trip([D1, D2, D3], [row([D1], 2190000, 1890000), row([D2], 2390000, 2090000), row([D3], 2190000, 1890000)], { adult_price: 2190000, child_price: 1890000 });
  const html = section(fields);
  const text = plain(html);
  assert.equal(rows(html), 2, "two rows for three days");
  assert.ok(text.includes(`5/8 ${wd(D1)} 5/22 ${wd(D3)}`), "the two days of one price side by side");
  assert.ok(html.includes(`aria-label="5/8 ${wd(D1)}, 5/22 ${wd(D3)} — Том хүн 2,190,000₮ · Хүүхэд 1,890,000₮"`), "a row reads as one line of dates and fares");
  assert.equal((text.match(new RegExp(`5/8 ${wd(D1)}`, "g")) || []).length, 1, "a day is written in one row");
  assert.ok(text.includes("«эхлэх үнэ» 2,190,000₮"), "the website's «from» price");
  assert.ok(text.includes("2,190,000₮") && text.includes("2,390,000₮"), "the fares read as amounts");
  assert.equal(html.includes("<input"), false, "no boxes until a row is opened");
  const open = section(fields, "g0");
  assert.ok(open.includes('value="2,190,000"') && open.includes('value="1,890,000"'), "an opened row edits its fares");
  assert.ok(plain(open).includes("Өдөр салгах, шилжүүлэх"), "a row of two days can be split");
});

test("no price rows: one row for all days; «Энэ огнооны үнэ өөр бол…» is the one action to give a day its own price", () => {
  const fields = trip([D1, D2, D3], [], { adult_price: 3290000, child_price: 2590000 });
  const html = section(fields);
  assert.equal(rows(html), 1);
  assert.ok(plain(html).includes(`5/8 ${wd(D1)} 5/15 ${wd(D2)} 5/22 ${wd(D3)}`), "the three days in the one row");
  const text = plain(section(fields, "all"));
  assert.ok(text.includes("Энэ огнооны үнэ өөр бол…"));
  assert.equal(text.includes("Тусдаа үнийг болих"), false, "nothing to undo yet");
  // One day: nothing to split.
  assert.equal(plain(section(trip([D1], [], { adult_price: 3290000, child_price: 2590000 }), "all")).includes("Энэ огнооны үнэ өөр бол"), false);
});

test("adult and child are required and red while empty; the infant is optional; a complete row has no red", () => {
  const fields = trip([D1, D2], [], { adult_price: 3290000 });
  assert.equal((plain(section(fields)).match(/Оруулаагүй/g) || []).length, 1, "the table's child cell says it, in red, before anything is opened");
  const empty = section(fields, "all");
  assert.ok(empty.includes('aria-invalid="true"'), "the empty child box is invalid");
  assert.equal((empty.match(/aria-invalid="true"/g) || []).length, 1, "only the child box: the adult fare is there");
  assert.ok(/text-danger[^"]*">Дутуу</.test(empty), "its label says missing, in red");
  assert.ok(empty.includes("border-danger"));
  assert.equal(/aria-label="Нярайн үнэ/.test(empty), false, "the optional infant box is not shown while empty");
  assert.ok(plain(empty).includes("Нярай"), "it is one chip away");
  const text = plain(review(fields));
  assert.ok(text.includes("хүүхдийн үнэ оруулаагүй."), "the problems list names the missing fare");
  assert.ok(text.includes("Ноорог болгон хадгалж болно."), "a draft needs neither");
  const none = section(trip([D1], []), "all");
  assert.equal((none.match(/aria-invalid="true"/g) || []).length, 2, "nothing entered: adult and child");
  const complete = section(trip([D1, D2], [], { adult_price: 3290000, child_price: 2590000 }), "all");
  assert.equal(complete.includes("aria-invalid"), false);
  assert.equal(complete.includes("border-danger"), false);
  assert.equal(plain(complete).includes("Оруулаагүй"), false, "no red once both are there");
});

test("a row for days that already left is not asked for its fares, and says so", () => {
  const fields = trip(["2000-01-05", D1], [row(["2000-01-05"], 1990000, null), row([D1], 2190000, 1890000)]);
  const html = section(fields);
  assert.equal(plain(html).includes("Оруулаагүй"), false);
  assert.ok(plain(html).includes("Өнгөрсөн"));
  assert.equal(section(fields, "g0").includes("aria-invalid"), false);
});

test("a day added later shows in the «Бусад өдөр» row, its fares red «Оруулаагүй»", () => {
  const fields = trip([D1, D2, D3], [row([D1], 2190000, 1890000), row([D2], 2390000, 2090000)]);
  const html = section(fields);
  const text = plain(html);
  assert.ok(text.includes("Бусад өдөр"));
  assert.equal((text.match(/Оруулаагүй/g) || []).length, 2, "adult and child of the unpriced day");
  assert.ok(text.includes(`5/22 ${wd(D3)}`));
  assert.ok(text.includes("2,190,000₮") && text.includes("2,390,000₮"), "the others keep their own price");
  assert.equal((section(fields, "all").match(/aria-invalid="true"/g) || []).length, 2, "opened: both boxes red");
});

test("a row's hotel and package show in their column and their boxes; an empty single-room extra or note is a chip; infant «Үнэгүй» is a checkbox", () => {
  const fields = trip([D1], [row([D1], 2190000, 1890000, { hotel: "Норвел 4*", package_id: "Хөтөлбөртэй" })]);
  assert.ok(plain(section(fields)).includes("Норвел 4* · Хөтөлбөртэй"), "the row shows its hotel and package");
  const html = section(fields, "g0");
  const text = plain(html);
  assert.ok(html.includes('value="Норвел 4*"') && html.includes('value="Хөтөлбөртэй"'));
  assert.ok(text.includes("Холбоос, зургийг доорх «Зочид буудал»-д нэмнэ."), "the hint names the part that exists in the review");
  assert.equal(/aria-label="Ганц өрөөний нэмэлт төлбөр"/.test(html), false, "no single-room box while empty");
  assert.ok(text.includes("Ганц өрөө") && text.includes("Тэмдэглэл"), "they are chips");
  const free = section(trip([D1], [row([D1], 2190000, 1890000, { passenger_prices: [
    { label: "Хүүхэд", age_range: "", price: 1890000, currency: "MNT" }, { label: "Нярай", age_range: "0-23 сар", price: 0, currency: "MNT", note: "Үнэгүй" },
  ] })]), "g0");
  assert.ok(/type="checkbox"[^>]*checked/.test(free) && plain(free).includes("Үнэгүй"), "a free infant is the «Үнэгүй» checkbox");
});

test("the file's second child tier shows as an extra row under a heading that says what it is", () => {
  const html = section(trip([D1], [row([D1], 2190000, 1890000, { passenger_prices: [
    { label: "Хүүхэд", age_range: "", price: 1890000, currency: "MNT" },
    { label: "Хүүхэд ор эзлэхгүй", age_range: "", price: 1500000, currency: "MNT" },
  ] })]), "g0");
  assert.ok(plain(html).includes("Өөр ангиллын үнэ"));
  assert.ok(html.includes('value="Хүүхэд ор эзлэхгүй"') && html.includes('value="1,500,000"'));
  assert.ok(html.includes('value="1,890,000"'), "the child fare keeps its own box");
  const table = plain(section(trip([D1], [row([D1], 2190000, 1890000, { passenger_prices: [
    { label: "Хүүхэд", age_range: "", price: 1890000, currency: "MNT" },
    { label: "Хүүхэд ор эзлэхгүй", age_range: "", price: 1500000, currency: "MNT" },
  ] })])));
  assert.ok(table.includes("Хүүхэд ор эзлэхгүй") && table.includes("1,500,000₮"), "the table has a column for it");
});

test("the rest of the review: whole facts instead of cut-off lines, one name for each website text, the bot's terms say so", () => {
  const html = review(trip([D1], [], { adult_price: 3290000, child_price: 2590000 }));
  const text = plain(html);
  assert.ok(/<textarea[^>]*aria-label="Үнэд багтсан 1"/.test(html), "a long line of what the price includes is shown whole");
  assert.equal(/<input[^>]*aria-label="Үнэд багтсан 1"/.test(html), false);
  assert.ok(text.includes("Бот «урьдчилгаа хэд вэ?»"), "the empty booking terms say the bot answers from them");
  assert.ok(text.includes("Товч танилцуулга") && text.includes("Хуудасны тайлбар"), "the two website texts, by one name each");
  assert.equal(text.includes("Тэмдэглэл заавал биш"), false, "the old vague «Тэмдэглэл» box");
  assert.ok(text.includes("Насны ангилал"), "age bands sit beside the prices they describe");
  assert.ok(text.indexOf("Нэг хүний үнэ, төгрөгөөр") < text.indexOf("Насны ангилал"));
});

test("what stops a publish or a save is said beside its field: no departure day, an empty name, a program that cannot be switched", () => {
  const html = review({ ...trip([], []), route_name: "" });
  const text = plain(html);
  assert.ok(text.includes("Гарах өдөр сонгоогүй. Нийтлэхийн тулд календариас дор хаяж нэг өдөр сонгоно уу. Ноорог болгон хадгалж болно."), "the calendar says it needs a day");
  assert.ok(/id="review-route-name"[^>]*aria-invalid="true"/.test(html) || /aria-invalid="true"[^>]*id="review-route-name"/.test(html), "an empty name blocks every save: red");
  assert.ok(plain(review({ ...trip([], []), route_name: "" }, "transport")).includes("Хөтөлбөр алга тул тээврийг сонгох боломжгүй."), "a transport switch that cannot work says why");
  const fine = plain(review(trip([D1], [], { adult_price: 3290000, child_price: 2590000 })));
  assert.equal(fine.includes("Нийтлэхийн тулд календариас"), false);
});
