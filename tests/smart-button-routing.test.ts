import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

applyTestEnv();

let routeFastPathText: typeof import("../src/lib/fastPathRouting").routeFastPathText;
let buildSmartButtons: typeof import("../src/lib/travelFastPaths").buildSmartButtons;
let SMART_BUTTON_LABELS: typeof import("../src/lib/smartButtonLabels").SMART_BUTTON_LABELS;
let CONTACT_OPERATOR_LABEL: string;

before(async () => {
  ({ routeFastPathText } = await import("../src/lib/fastPathRouting"));
  ({ buildSmartButtons } = await import("../src/lib/travelFastPaths"));
  ({ SMART_BUTTON_LABELS } = await import("../src/lib/smartButtonLabels"));
  ({ CONTACT_OPERATOR_LABEL } = await import("../src/lib/contactLabels"));
});

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "t", category: "", operator_name: "Uudam", route_name: "Trip",
    duration_text: "6 өдөр 5 шөнө", adult_price: 1000000, child_price: 900000,
    infant_price: null, currency: "MNT", departure_dates: ["10 сарын 8"],
    seats_total: null, seats_left: null, has_food: null, status: "active",
    notes: "", hotel: "", source_description: "", photo_urls: [], extra: {},
    created_at: "", updated_at: "", ...fields,
  } as TravelTrip;
}

// The exact live catalog collision: the button label "Хөтөлбөр үзэх" contains
// "үзэх", which is a real word in this trip's NAME.
const ORDOS = trip({ id: "ordos", route_name: "Ордос -намрын тахилга үзэх аялал" });
const SHANGHAI = trip({ id: "shanghai", route_name: "ШАНХАЙ - ДИСНЕЙЛЭНД-10/08" });
const CATALOG = [ORDOS, SHANGHAI];

test("tapping Хөтөлбөр үзэх keeps the trip the customer was looking at", async () => {
  // Regression, confirmed in a real Messenger conversation 2026-09-11: the
  // customer was shown ШАНХАЙ, tapped "Хөтөлбөр үзэх", and got the Ордос
  // brochure — the bare label name-matched "…тахилга үзэх аялал".
  const routed = await routeFastPathText({
    senderId: "test-button-sender",
    text: SMART_BUTTON_LABELS.PROGRAM,
    contextualUserText: `${SHANGHAI.route_name}\n${SMART_BUTTON_LABELS.PROGRAM}`,
    trips: CATALOG,
  });
  assert.match(routed.matchText, /ШАНХАЙ/);
  assert.doesNotMatch(routed.matchText, /Ордос/);
});

test("a customer genuinely naming the Ордос trip still gets Ордос", async () => {
  const routed = await routeFastPathText({
    senderId: "test-real-name-sender",
    text: "Ордос -намрын тахилга үзэх аялал",
    contextualUserText: "Ордос -намрын тахилга үзэх аялал",
    trips: CATALOG,
  });
  assert.match(routed.matchText, /Ордос/);
});

test("every smart-button set offers a way to reach a human", () => {
  // The operator option used to be appended only on the AI reply path, so
  // fast-path answers (price, programme, dates) silently dropped it — the
  // choice has to be visible to be a choice.
  const buttons = buildSmartButtons(`✈️ ${SHANGHAI.route_name}`, CATALOG);
  assert.ok(buttons, "expected buttons for a resolvable trip");
  assert.ok(buttons!.includes(CONTACT_OPERATOR_LABEL));
});

test("smart buttons still lead with the programme and booking actions", () => {
  const buttons = buildSmartButtons(`✈️ ${SHANGHAI.route_name}`, CATALOG)!;
  assert.equal(buttons[0], SMART_BUTTON_LABELS.PROGRAM);
  assert.ok(buttons.includes(SMART_BUTTON_LABELS.BOOK));
});
