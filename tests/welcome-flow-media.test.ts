import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

async function loadWelcomeFlow() {
  applyTestEnv();
  return import("../src/lib/welcomeFlow");
}

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "Outbound",
    operator_name: "Uudam Travel",
    route_name: "Surmak Felmor",
    duration_text: "5 days",
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
    photo_urls: ["https://example.com/surmak-felmor-1.jpg", "https://example.com/surmak-felmor-2.jpg"],
    extra: {},
    created_at: "",
    updated_at: "",
    ...fields,
  };
}

test("normal information requests do not opt into photos", async () => {
  const { hasTripPhotoIntent } = await loadWelcomeFlow();
  assert.equal(hasTripPhotoIntent("Кардан аяллын үнэ хэд вэ?"), false);
  assert.equal(hasTripPhotoIntent("Кардан аяллын зураг явуулаач"), true);
  assert.equal(hasTripPhotoIntent("kardan zurag"), true);
  assert.equal(hasTripPhotoIntent("send photos"), true);
});

test("default welcome points customers to the website and contact numbers", async () => {
  const { DEFAULT_WELCOME_TEXT } = await loadWelcomeFlow();
  assert.match(DEFAULT_WELCOME_TEXT, /uudam-booking-web\.vercel\.app/);
  assert.match(DEFAULT_WELCOME_TEXT, /7713 6633/);
  assert.match(DEFAULT_WELCOME_TEXT, /Та ямар төрлийн аялал сонирхож байна вэ/);
});

test("trip media fails closed when only a shared destination token matches", async () => {
  const { extractTripPhotosForReply } = await loadWelcomeFlow();
  const photos = extractTripPhotosForReply(
    "Surmak trip price is 1,000.",
    [
      trip({ id: "felmor", route_name: "Surmak Felmor" }),
      trip({
        id: "anmor",
        route_name: "Surmak Anmor",
        photo_urls: ["https://example.com/surmak-anmor.jpg"],
      }),
    ],
  );

  assert.deepEqual(photos, []);
});

test("trip media requires user and reply to agree before sending attachments", async () => {
  const { extractTripPhotosForReply } = await loadWelcomeFlow();
  const photos = extractTripPhotosForReply(
    "Surmak Anmor program images are ready.",
    [
      trip({ id: "felmor", route_name: "Surmak Felmor" }),
      trip({
        id: "anmor",
        route_name: "Surmak Anmor",
        photo_urls: ["https://example.com/surmak-anmor.jpg"],
      }),
    ],
    { userText: "Please send Surmak Felmor program" },
  );

  assert.deepEqual(photos, []);
});

test("trip media sends only after the same specific trip passes both gates", async () => {
  const { extractTripPhotosForReply } = await loadWelcomeFlow();
  const photos = extractTripPhotosForReply(
    "Surmak Felmor program images are ready.",
    [
      trip({ id: "felmor", route_name: "Surmak Felmor" }),
      trip({
        id: "anmor",
        route_name: "Surmak Anmor",
        photo_urls: ["https://example.com/surmak-anmor.jpg"],
      }),
    ],
    { userText: "Please send Surmak Felmor program" },
  );

  assert.deepEqual(photos, [
    "https://example.com/surmak-felmor-1.jpg",
    "https://example.com/surmak-felmor-2.jpg",
  ]);
});

test("photo-only mode prefers the combined route when the user names both destinations", async () => {
  const { extractTripPhotosForUserMessage } = await loadWelcomeFlow();
  const photos = extractTripPhotosForUserMessage(
    "Lumia Zetgor photo",
    [
      trip({
        id: "zetgor",
        route_name: "Zetgor direct flight",
        photo_urls: ["https://example.com/zetgor-direct-1.jpg"],
      }),
      trip({
        id: "lumia-zetgor",
        route_name: "Lumia Zetgor direct flight",
        photo_urls: ["https://example.com/lumia-zetgor-1.jpg", "https://example.com/lumia-zetgor-2.jpg"],
      }),
    ],
  );

  assert.deepEqual(photos, [
    "https://example.com/lumia-zetgor-1.jpg",
    "https://example.com/lumia-zetgor-2.jpg",
  ]);
});

test("photo-only mode does not borrow photos from a shared-city trip with fewer query tokens", async () => {
  const { extractTripPhotosForUserMessage } = await loadWelcomeFlow();
  const photos = extractTripPhotosForUserMessage(
    "Sargol exam ground tour photo",
    [
      trip({
        id: "sargol-exam",
        route_name: "Sargol exam ground tour",
        photo_urls: [],
      }),
      trip({
        id: "selvin-sargol",
        route_name: "Selvin mini avatar Sargol tour",
        photo_urls: ["https://example.com/selvin-sargol-1.jpg"],
      }),
    ],
  );

  assert.deepEqual(photos, []);
});

test("reply media does not borrow photos when the exact discussed trip has none", async () => {
  const { extractTripPhotosForReply } = await loadWelcomeFlow();
  const trips = [
    trip({
      id: "sargol-exam",
      route_name: "Sargol exam ground tour",
      photo_urls: [],
    }),
    trip({
      id: "selvin-sargol",
      route_name: "Selvin mini avatar Sargol tour",
      photo_urls: ["https://example.com/selvin-sargol-1.jpg"],
    }),
  ];

  const photos = extractTripPhotosForReply(
    "Sargol exam ground tour price is 1,100,000 MNT.",
    trips,
    { userText: "Sargol exam ground tour photo" },
  );

  assert.deepEqual(photos, []);
});

test("trip media keeps complete five-slice poster sets", async () => {
  const { extractTripPhotosForReply, extractTripPhotosForUserMessage } = await loadWelcomeFlow();
  const posterSlices = [
    "https://example.com/surmak-felmor-1.jpg",
    "https://example.com/surmak-felmor-2.jpg",
    "https://example.com/surmak-felmor-3.jpg",
    "https://example.com/surmak-felmor-4.jpg",
    "https://example.com/surmak-felmor-5.jpg",
  ];
  const trips = [
    trip({
      id: "felmor",
      route_name: "Surmak Felmor",
      photo_urls: posterSlices,
    }),
  ];

  assert.deepEqual(
    extractTripPhotosForReply(
      "Surmak Felmor program images are ready.",
      trips,
      { userText: "Please send Surmak Felmor photos" },
    ),
    posterSlices,
  );
  assert.deepEqual(
    extractTripPhotosForUserMessage("Please send Surmak Felmor photos", trips),
    posterSlices,
  );
});

test("photo-only mode resolves the trip directly from the user message", async () => {
  const { extractTripPhotosForUserMessage } = await loadWelcomeFlow();
  const photos = extractTripPhotosForUserMessage(
    "Вэлмор Кардэн газар нислэг хосолсон аяллын зураг үзье",
    [
      trip({
        id: "ground-tour",
        route_name: "Сэрвэн тэнгис буюу Кардан-Вэлморгийн газрын аялал",
        photo_urls: ["https://example.com/ground-tour.jpg"],
      }),
      trip({
        id: "combo-tour",
        route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
        photo_urls: ["https://example.com/combo-tour-1.jpg", "https://example.com/combo-tour-2.jpg"],
        extra: {
          aliases: [
            "Вэлмор Кардэн газар нислэг хосолсон",
            "Кардэн Вэлмор газар нислэг",
          ],
        },
      }),
    ],
  );

  assert.deepEqual(photos, [
    "https://example.com/combo-tour-1.jpg",
    "https://example.com/combo-tour-2.jpg",
  ]);
});

test("photo-only mode matches romanized travel text against Cyrillic trip aliases", async () => {
  const { extractTripPhotosForUserMessage } = await loadWelcomeFlow();
  const photos = extractTripPhotosForUserMessage(
    "velmor beidehi gazr nisleg hosolson uzie",
    [
      trip({
        id: "ground-tour",
        route_name: "Сэрвэн тэнгис буюу Кардан-Вэлморгийн газрын аялал",
        photo_urls: ["https://example.com/ground-tour.jpg"],
      }),
      trip({
        id: "combo-tour",
        route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
        photo_urls: ["https://example.com/combo-tour-1.jpg", "https://example.com/combo-tour-2.jpg"],
        extra: {
          aliases: [
            "Вэлмор Кардэн газар нислэг хосолсон",
            "Кардэн Вэлмор газар нислэг",
          ],
        },
      }),
    ],
  );

  assert.deepEqual(photos, [
    "https://example.com/combo-tour-1.jpg",
    "https://example.com/combo-tour-2.jpg",
  ]);
});

test("photo-only mode treats gazrin phrasing as land-only and excludes combo trips", async () => {
  const { extractTripPhotosForUserMessage } = await loadWelcomeFlow();
  const photos = extractTripPhotosForUserMessage(
    "velmor gazrin aylal bnu",
    [
      trip({
        id: "ground-tour",
        route_name: "Вэлмор газрын аялал",
        category: "газрын аялал",
        photo_urls: ["https://example.com/velmor-ground-1.jpg"],
      }),
      trip({
        id: "combo-tour",
        route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
        category: "газар + нислэг хосолсон",
        photo_urls: ["https://example.com/combo-tour-1.jpg"],
        extra: {
          aliases: [
            "Вэлмор Кардэн газар нислэг хосолсон",
            "Кардэн Вэлмор газар нислэг",
          ],
        },
      }),
    ],
  );

  assert.deepEqual(photos, ["https://example.com/velmor-ground-1.jpg"]);
});

test("photo-only mode excludes cruise trips from gazrin land-tour phrasing", async () => {
  const { extractTripPhotosForUserMessage } = await loadWelcomeFlow();
  const photos = extractTripPhotosForUserMessage(
    "velmor gazrin aylal bnu",
    [
      trip({
        id: "ground-tour",
        route_name: "Вэлмор газрын аялал",
        category: "газрын аялал",
        photo_urls: ["https://example.com/velmor-ground-1.jpg"],
      }),
      trip({
        id: "cruise-tour",
        route_name: "Усан онгоцны аялал - Ормак - Вэлмор - Дорнэл - Талвин Вирдэн",
        category: "круз аялал",
        photo_urls: ["https://example.com/velmor-cruise-1.jpg"],
      }),
    ],
  );

  assert.deepEqual(photos, ["https://example.com/velmor-ground-1.jpg"]);
});

test("brochure matching also refuses mismatched user and reply trips", async () => {
  const { extractTripBrochureAttachmentId } = await loadWelcomeFlow();
  const brochure = extractTripBrochureAttachmentId(
    "Surmak Anmor PDF is ready.",
    [
      trip({
        id: "felmor",
        route_name: "Surmak Felmor",
        extra: { brochure_pdf_url: "https://example.com/felmor.pdf" },
      }),
      trip({
        id: "anmor",
        route_name: "Surmak Anmor",
        extra: { brochure_pdf_url: "https://example.com/anmor.pdf" },
      }),
    ],
    { userText: "Please send Surmak Felmor PDF" },
  );

  assert.equal(brochure, null);
});

test("the webhook resolves a poster trip to the same rendered PDF the demo sends", async () => {
  const { extractTripBrochureAttachmentId } = await loadWelcomeFlow();
  const previousSiteUrl = process.env.SITE_URL;
  process.env.SITE_URL = "https://bot.example.com";
  try {
    const brochure = extractTripBrochureAttachmentId(
      "Surmak Felmor PDF хөтөлбөрийг хавсаргалаа.",
      [
        trip({
          id: "felmor",
          route_name: "Surmak Felmor",
          photo_urls: ["https://example.com/felmor-photo.jpg"],
          extra: { poster_trip_id: "poster-felmor" },
        }),
      ],
      { userText: "Surmak Felmor PDF явуулаач" },
    );

    assert.deepEqual(brochure, {
      type: "url",
      value: "https://bot.example.com/api/poster-pdf?id=poster-felmor",
    });
  } finally {
    if (previousSiteUrl === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = previousSiteUrl;
  }
});

test("handoff reply merges the confirmation and consultant numbers into one message", async () => {
  const { buildHandoffReplyWithContact, DEFAULT_HANDOFF_CONTACT_LINE } = await loadWelcomeFlow();
  const merged = buildHandoffReplyWithContact("Таны хүсэлтийг хүлээн авлаа. ", {});
  assert.equal(merged, `Таны хүсэлтийг хүлээн авлаа.\n\n${DEFAULT_HANDOFF_CONTACT_LINE}`);
  assert.match(merged, /7713-6633/);
  assert.match(merged, /8913-6633/);
  assert.match(merged, /9117-2769/);
  // Compact: numbers share one line instead of one line each.
  assert.equal(DEFAULT_HANDOFF_CONTACT_LINE.split("\n").length, 1);
});

test("an admin-customised goodbye text replaces the default handoff contact line", async () => {
  const { buildHandoffReplyWithContact, resolveGoodbyeContactText } = await loadWelcomeFlow();
  const extra = { goodbye: { text: "Залгах: 7000-0000" } };
  assert.equal(
    buildHandoffReplyWithContact("Хүлээн авлаа.", extra),
    "Хүлээн авлаа.\n\nЗалгах: 7000-0000",
  );
  assert.equal(resolveGoodbyeContactText(extra), "Залгах: 7000-0000");
  assert.match(resolveGoodbyeContactText({}), /7713-6633 · 8913-6633 · 9117-2769/);
});
