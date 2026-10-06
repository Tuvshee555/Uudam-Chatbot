import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TripDatePriceEditor } from "../src/components/admin/TripEditModal";
import { WebsiteTripFields } from "../src/components/admin/WebsiteTripFields";
import type { PriceGroup, TravelTrip } from "../src/lib/adminTypes";

test("dated fare fields have visible labels and do not repeat age in passenger names", () => {
  const group = {
    dates: ["2026-12-12"], adult_price: 4990000,
    passenger_prices: [{ label: "Хүүхэд 4-12 нас", age_range: "4-12 нас", price: 4490000, currency: "MNT" }],
  } as PriceGroup;
  const html = renderToStaticMarkup(React.createElement(TripDatePriceEditor, { groups: [group], onChange: () => {} }));
  assert.match(html, /Зорчигчийн нэр/);
  assert.match(html, /Насны хүрээ/);
  assert.match(html, /Нэг хүний үнэ/);
  assert.match(html, /value="Хүүхэд"/);
  assert.match(html, /value="4490000"/);
  assert.equal(group.passenger_prices[0].label, "Хүүхэд 4-12 нас");
});

const trip = { extra: { website_details: { hotelMedia: [{ url: "https://example.com/hotel.jpg", caption: "Pool", kind: "image" }], travelerMedia: [], country: "Thailand" } } } as unknown as TravelTrip;

test("hotel links, previews and file uploads live in the media view, not the general form", () => {
  const props = { trip, onChange: () => {}, apiFetch: async () => new Response() };
  const media = renderToStaticMarkup(React.createElement(WebsiteTripFields, { ...props, scope: "media" }));
  const general = renderToStaticMarkup(React.createElement(WebsiteTripFields, props));
  assert.match(media, /Буудлын зураг, бичлэг/);
  assert.match(media, /Холбоос нэмэх/);
  assert.match(media, /type="file"/);
  assert.match(media, /accept="image\/\*"/);
  assert.match(media, /accept="video\/\*"/);
  assert.match(media, /src="https:\/\/example.com\/hotel.jpg"/);
  assert.doesNotMatch(general, /hotel.jpg/);
  assert.match(general, /Байршил, зохион байгуулалт/);
});

test("incomplete hotel links remain editable without crashing the media preview", () => {
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(WebsiteTripFields, {
    trip, scope: "media", draft: JSON.stringify({ hotelMedia: [{ url: "https://", caption: "" }] }), onChange: () => {},
  })));
});
