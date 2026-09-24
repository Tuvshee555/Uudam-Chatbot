import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "Outbound",
    operator_name: "Uudam Travel",
    route_name: "Trip",
    duration_text: "8 \u04e9\u0434\u04e9\u0440 / 7 \u0448\u04e9\u043d\u04e9",
    adult_price: 1000,
    child_price: 800,
    infant_price: null,
    currency: "MNT",
    departure_dates: [],
    seats_total: null,
    seats_left: null,
    has_food: null,
    status: "active",
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: [],
    extra: {},
    created_at: "",
    updated_at: "",
    ...fields,
  };
}

test("photo request maps Lumia Peldor to the Lumia variant", async () => {
  applyTestEnv();
  const { extractTripPhotosForUserMessage } = await import("../src/lib/welcomeFlow");
  const photos = extractTripPhotosForUserMessage(
    "\u041b\u0443\u043c\u0438\u0430 \u041f\u044d\u043b\u0434\u043e\u0440 \u0437\u0443\u0440\u0430\u0433",
    [
      trip({
        id: "zetgor-direct",
        route_name: "\u0417\u044d\u0442\u0433\u043e\u0440\u0438\u0439\u043d \u0445\u0430\u0430\u043b\u0433\u0430 - \u0448\u0443\u0443\u0434 \u043d\u0438\u0441\u043b\u044d\u0433\u0442\u044d\u0439",
        photo_urls: ["https://example.com/zetgor-direct-1.jpg"],
        extra: {
          aliases: ["\u041f\u044d\u043b\u0434\u043e\u0440", "Peldor"],
        },
      }),
      trip({
        id: "lumia-zetgor",
        route_name: "\u041b\u0443\u043c\u0438\u0430 + \u0417\u044d\u0442\u0433\u043e\u0440\u0438\u0439\u043d \u0445\u0430\u0430\u043b\u0433\u0430 \u0448\u0443\u0443\u0434 \u043d\u0438\u0441\u043b\u044d\u0433\u0442\u044d\u0439 \u0430\u044f\u043b\u0430\u043b",
        photo_urls: [
          "https://example.com/lumia-zetgor-1.jpg",
          "https://example.com/lumia-zetgor-2.jpg",
        ],
        extra: {
          aliases: [
            "\u041b\u0443\u043c\u0438\u0430 \u041f\u044d\u043b\u0434\u043e\u0440",
            "Lumia Peldor",
          ],
        },
      }),
    ],
  );

  assert.deepEqual(photos, [
    "https://example.com/lumia-zetgor-1.jpg",
    "https://example.com/lumia-zetgor-2.jpg",
  ]);
});

test("program request maps Lumia Peldor to the Lumia variant", async () => {
  applyTestEnv();
  const { buildTripProgramReply } = await import("../src/lib/travelFastPathsProgram");
  const result = buildTripProgramReply(
    "\u041b\u0443\u043c\u0438\u0430 \u041f\u044d\u043b\u0434\u043e\u0440 \u0445\u04e9\u0442\u04e9\u043b\u0431\u04e9\u0440",
    [
      trip({
        id: "zetgor-direct",
        route_name: "\u0417\u044d\u0442\u0433\u043e\u0440\u0438\u0439\u043d \u0445\u0430\u0430\u043b\u0433\u0430 - \u0448\u0443\u0443\u0434 \u043d\u0438\u0441\u043b\u044d\u0433\u0442\u044d\u0439",
        extra: {
          aliases: ["\u041f\u044d\u043b\u0434\u043e\u0440", "Peldor"],
        },
      }),
      trip({
        id: "lumia-zetgor",
        route_name: "\u041b\u0443\u043c\u0438\u0430 + \u0417\u044d\u0442\u0433\u043e\u0440\u0438\u0439\u043d \u0445\u0430\u0430\u043b\u0433\u0430 \u0448\u0443\u0443\u0434 \u043d\u0438\u0441\u043b\u044d\u0433\u0442\u044d\u0439 \u0430\u044f\u043b\u0430\u043b",
        extra: {
          aliases: [
            "\u041b\u0443\u043c\u0438\u0430 \u041f\u044d\u043b\u0434\u043e\u0440",
            "Lumia Peldor",
          ],
          program_images: ["https://example.com/lumia-program-1.jpg"],
        },
      }),
    ],
  );

  assert.equal(result?.trip?.id, "lumia-zetgor");
  assert.deepEqual(result?.mediaUrls, ["https://example.com/lumia-program-1.jpg"]);
});
