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

test("photo request maps Shanghai Zhangjiajie to the Shanghai variant", async () => {
  applyTestEnv();
  const { extractTripPhotosForUserMessage } = await import("../src/lib/welcomeFlow");
  const photos = extractTripPhotosForUserMessage(
    "\u0428\u0430\u043d\u0445\u0430\u0439 \u0416\u0430\u043d\u0436\u0438\u0430\u0436\u044d \u0437\u0443\u0440\u0430\u0433",
    [
      trip({
        id: "tenger-direct",
        route_name: "\u0422\u044d\u043d\u0433\u044d\u0440\u0438\u0439\u043d \u0445\u0430\u0430\u043b\u0433\u0430 - \u0448\u0443\u0443\u0434 \u043d\u0438\u0441\u043b\u044d\u0433\u0442\u044d\u0439",
        photo_urls: ["https://example.com/tenger-direct-1.jpg"],
        extra: {
          aliases: ["\u0416\u0430\u043d\u0436\u0438\u0430\u0436\u044d", "Zhangjiajie"],
        },
      }),
      trip({
        id: "shanghai-tenger",
        route_name: "\u0428\u0430\u043d\u0445\u0430\u0439 + \u0422\u044d\u043d\u0433\u044d\u0440\u0438\u0439\u043d \u0445\u0430\u0430\u043b\u0433\u0430 \u0448\u0443\u0443\u0434 \u043d\u0438\u0441\u043b\u044d\u0433\u0442\u044d\u0439 \u0430\u044f\u043b\u0430\u043b",
        photo_urls: [
          "https://example.com/shanghai-tenger-1.jpg",
          "https://example.com/shanghai-tenger-2.jpg",
        ],
        extra: {
          aliases: [
            "\u0428\u0430\u043d\u0445\u0430\u0439 \u0416\u0430\u043d\u0436\u0438\u0430\u0436\u044d",
            "Shanghai Zhangjiajie",
          ],
        },
      }),
    ],
  );

  assert.deepEqual(photos, [
    "https://example.com/shanghai-tenger-1.jpg",
    "https://example.com/shanghai-tenger-2.jpg",
  ]);
});

test("program request maps Shanghai Zhangjiajie to the Shanghai variant", async () => {
  applyTestEnv();
  const { buildTripProgramReply } = await import("../src/lib/travelFastPathsProgram");
  const result = buildTripProgramReply(
    "\u0428\u0430\u043d\u0445\u0430\u0439 \u0416\u0430\u043d\u0436\u0438\u0430\u0436\u044d \u0445\u04e9\u0442\u04e9\u043b\u0431\u04e9\u0440",
    [
      trip({
        id: "tenger-direct",
        route_name: "\u0422\u044d\u043d\u0433\u044d\u0440\u0438\u0439\u043d \u0445\u0430\u0430\u043b\u0433\u0430 - \u0448\u0443\u0443\u0434 \u043d\u0438\u0441\u043b\u044d\u0433\u0442\u044d\u0439",
        extra: {
          aliases: ["\u0416\u0430\u043d\u0436\u0438\u0430\u0436\u044d", "Zhangjiajie"],
        },
      }),
      trip({
        id: "shanghai-tenger",
        route_name: "\u0428\u0430\u043d\u0445\u0430\u0439 + \u0422\u044d\u043d\u0433\u044d\u0440\u0438\u0439\u043d \u0445\u0430\u0430\u043b\u0433\u0430 \u0448\u0443\u0443\u0434 \u043d\u0438\u0441\u043b\u044d\u0433\u0442\u044d\u0439 \u0430\u044f\u043b\u0430\u043b",
        extra: {
          aliases: [
            "\u0428\u0430\u043d\u0445\u0430\u0439 \u0416\u0430\u043d\u0436\u0438\u0430\u0436\u044d",
            "Shanghai Zhangjiajie",
          ],
          program_images: ["https://example.com/shanghai-program-1.jpg"],
        },
      }),
    ],
  );

  assert.equal(result?.trip?.id, "shanghai-tenger");
  assert.deepEqual(result?.mediaUrls, ["https://example.com/shanghai-program-1.jpg"]);
});
