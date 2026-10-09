import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DayMealToggles, DayPhotoPreview } from "../src/components/admin/ItineraryDayControls";

const render = (meals: { breakfast?: boolean; lunch?: boolean; dinner?: boolean } | undefined) =>
  renderToStaticMarkup(createElement(DayMealToggles, { meals, onToggle: () => undefined }));

function pressed(html: string) {
  return [...html.matchAll(/aria-pressed="(true|false)"[^>]*>[\s\S]*?(Өглөөний цай|Өдрийн хоол|Оройн хоол)/g)]
    .map((m) => `${m[2]}:${m[1]}`);
}

test("the three meals are toggle chips that show on or off for each", () => {
  assert.deepEqual(pressed(render({ breakfast: true, lunch: false, dinner: true })), [
    "Өглөөний цай:true", "Өдрийн хоол:false", "Оройн хоол:true",
  ]);
});

test("a day with no meal data shows all three as off", () => {
  assert.deepEqual(pressed(render(undefined)), ["Өглөөний цай:false", "Өдрийн хоол:false", "Оройн хоол:false"]);
});

test("only an included meal carries the check mark", () => {
  const html = render({ breakfast: true });
  assert.equal((html.match(/<svg/g) || []).length, 1);
});

test("a day's photo is shown, and nothing is drawn when the day has none", () => {
  const withPhoto = renderToStaticMarkup(createElement(DayPhotoPreview, { photo: "https://res.cloudinary.com/x/a.jpg", title: "Өдөр 3" }));
  assert.match(withPhoto, /<img[^>]+src="https:\/\/res\.cloudinary\.com\/x\/a\.jpg"/);
  assert.match(withPhoto, /Постер таб/);
  assert.equal(renderToStaticMarkup(createElement(DayPhotoPreview, { title: "Өдөр 1" })), "");
});
