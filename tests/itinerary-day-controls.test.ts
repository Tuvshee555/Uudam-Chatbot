import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DayMealToggles, DayPhotoPreview, nextMeal } from "../src/components/admin/ItineraryDayControls";

const render = (meals: { breakfast?: boolean | null; lunch?: boolean | null; dinner?: boolean | null } | undefined) =>
  renderToStaticMarkup(createElement(DayMealToggles, { meals, onChange: () => undefined }));

function states(html: string) {
  return [...html.matchAll(/aria-label="(Өглөөний цай|Өдрийн хоол|Оройн хоол): ([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
}

test("each meal says included, at the traveller's cost, or not stated by the source", () => {
  assert.deepEqual(states(render({ breakfast: true, lunch: false, dinner: null })), [
    "Өглөөний цай:багтсан", "Өдрийн хоол:өөрийн зардлаар", "Оройн хоол:файлд дурдаагүй",
  ]);
});

test("a day with no meal data is 'not stated', never 'not included'", () => {
  assert.deepEqual(states(render(undefined)), ["Өглөөний цай:файлд дурдаагүй", "Өдрийн хоол:файлд дурдаагүй", "Оройн хоол:файлд дурдаагүй"]);
});

test("one click: not stated → included, included → own cost, own cost → included", () => {
  assert.deepEqual([nextMeal(null), nextMeal(undefined), nextMeal(true), nextMeal(false)], [true, true, false, true]);
});

test("only an included meal is pressed", () => {
  const html = render({ breakfast: true, lunch: false });
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
});

test("a day's photo is shown, and nothing is drawn when the day has none", () => {
  const withPhoto = renderToStaticMarkup(createElement(DayPhotoPreview, { photo: "https://res.cloudinary.com/x/a.jpg", title: "Өдөр 3" }));
  assert.match(withPhoto, /<img[^>]+src="https:\/\/res\.cloudinary\.com\/x\/a\.jpg"/);
  assert.match(withPhoto, /Постер таб/);
  assert.equal(renderToStaticMarkup(createElement(DayPhotoPreview, { title: "Өдөр 1" })), "");
});
