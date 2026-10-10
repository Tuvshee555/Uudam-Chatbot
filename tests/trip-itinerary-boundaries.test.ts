import test from "node:test";
import assert from "node:assert/strict";
import { auditTripFacts } from "../src/lib/tripDataValidation";
import { itineraryEndsInUlaanbaatar, itineraryStartsInUlaanbaatar } from "../src/lib/tripItineraryBoundaries";

test("recognizes Ulaanbaatar and UB outbound travel days", () => {
  assert.equal(itineraryStartsInUlaanbaatar({
    title: "УБ - Замын-Үүд",
    description: "УБ-аас галт тэргээр хөдөлнө.",
  }), true);
  assert.equal(itineraryStartsInUlaanbaatar({
    title: "Улаанбаатар - Дананг",
    description: "Чингис Хаан нисэх буудлаас Дананг руу ниснэ.",
  }), true);
});

test("requires the final description to complete the return, not merely reach a foreign airport", () => {
  assert.equal(itineraryEndsInUlaanbaatar({
    title: "УБ хот руу буцах өдөр",
    description: "19:30 цагт Саняа Финикс нисэх онгоцны буудал дээр ирж бүртгэлээ хийлгэнэ.",
  }), false);
  assert.equal(itineraryEndsInUlaanbaatar({
    title: "Дананг - Улаанбаатар",
    description: "Чингис Хаан олон улсын нисэх буудалд газардсанаар аялал өндөрлөнө.",
  }), true);
});

test("catalog validation rejects an itinerary missing either Ulaanbaatar boundary", () => {
  const result = auditTripFacts({
    id: "trip-test",
    extra: {
      itinerary_days: [
        { title: "Эрээн - Бээжин", description: "Бээжин рүү хөдөлнө." },
        { title: "Бээжин - Эрээн", description: "Эрээнд аялал дуусна." },
      ],
    },
  });
  assert.deepEqual(result.errors.map((issue) => issue.code), [
    "itinerary_missing_ulaanbaatar_start",
    "itinerary_missing_ulaanbaatar_end",
  ]);
});
