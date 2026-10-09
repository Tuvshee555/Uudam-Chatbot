import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TripGroups } from "../src/components/admin/TripsTab";
import type { TravelTrip } from "../src/lib/adminTypes";

function trip(id: string, name: string, status: string): TravelTrip {
  return {
    id, category: "Аялал", operator_name: "", route_name: name, duration_text: "5 өдөр 4 шөнө",
    adult_price: 1_000_000, child_price: 800_000, infant_price: null, currency: "MNT", departure_dates: [],
    seats_total: null, seats_left: null, has_food: true, status, notes: "", hotel: "", source_description: "",
    photo_urls: [], extra: {}, created_at: "", updated_at: "",
  } as unknown as TravelTrip;
}

const noop = () => undefined;
const render = (trips: TravelTrip[]) => renderToStaticMarkup(createElement(TripGroups, {
  trips, onEdit: noop, onDelete: noop, onToggleVisible: noop, onFixPhotosOnPoster: noop, onAskAi: noop,
}));

test("live trips are listed first and drafts sit below, closed, with the other trips", () => {
  const html = render([
    trip("d1", "Ноорог аялал А", "draft"),
    trip("a1", "Идэвхтэй аялал Б", "active"),
    trip("s1", "Дүүрсэн аялал В", "sold_out"),
    trip("c1", "Цуцлагдсан аялал Г", "cancelled"),
  ]);
  assert.ok(html.indexOf("Идэвхтэй аялал") < html.indexOf("Ноорог") && html.indexOf("Ноорог") < html.indexOf("Цуцлагдсан, архивласан"));
  assert.ok(html.includes("Идэвхтэй аялал Б") && html.includes("Дүүрсэн аялал В"), "live trips are shown");
  assert.equal(html.includes("Ноорог аялал А"), false, "draft trips start closed");
  assert.equal(html.includes("Цуцлагдсан аялал Г"), false, "cancelled trips start closed");
});

test("when only drafts are on screen, they open instead of hiding the whole list", () => {
  const html = render([trip("d1", "Ноорог аялал А", "draft")]);
  assert.ok(html.includes("Ноорог аялал А"));
});
