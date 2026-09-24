import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelOps";

// fastPathRouting transitively loads env (redis state) at import time.
let routeFastPathText: typeof import("../src/lib/fastPathRouting").routeFastPathText;
let filterCandidatesByAttribute: typeof import("../src/lib/fastPathRouting").filterCandidatesByAttribute;
let clearClarificationState: typeof import("../src/lib/clarificationState").clearClarificationState;
let getClarificationState: typeof import("../src/lib/clarificationState").getClarificationState;

before(async () => {
  applyTestEnv();
  const routing = await import("../src/lib/fastPathRouting");
  routeFastPathText = routing.routeFastPathText;
  filterCandidatesByAttribute = routing.filterCandidatesByAttribute;
  const state = await import("../src/lib/clarificationState");
  clearClarificationState = state.clearClarificationState;
  getClarificationState = state.getClarificationState;
});

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "Outbound",
    operator_name: "Uudam Travel",
    route_name: "Аялал",
    duration_text: "5 өдөр / 4 шөнө",
    adult_price: 1000000,
    child_price: 900000,
    infant_price: null,
    currency: "MNT",
    departure_dates: ["8 сарын 1"],
    seats_total: null,
    seats_left: null,
    has_food: true,
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

// Mirrors the live catalog shape that produced the wrong-trip bug.
const TRIPS: TravelTrip[] = [
  trip({
    id: "kardan",
    route_name: "СЭРВЭН ТЭНГИС БУЮУ КАРДАН-ВЭЛМОРГИЙН ГАЗРЫН АЯЛАЛ",
    category: "Газрын",
    extra: { aliases: ["Кардан", "Kardan"] },
  }),
  trip({
    id: "lumia-zetgoriin",
    route_name: "Лумиа + Зэтгорийн хаалга шууд нислэгтэй аялал",
    category: "Шууд нислэгтэй",
    extra: { aliases: ["Lumia"] },
  }),
  trip({
    id: "lumia-hanzhou",
    route_name: "Лумиа+Хэлвин шууд нислэгтэй, усан парктай аялал",
    category: "Шууд нислэгтэй",
    extra: { aliases: ["Lumia", "Helvin"] },
  }),
];

test("LIVE BUG regression: clarification answer can never be hijacked by a stale trip from old turns", async () => {
  const senderId = "route-test-hijack";
  await clearClarificationState(senderId);

  // Turn 1: "lumia aylal medelel awy" — ambiguous between the two Lumia
  // trips; the router must remember those candidates and must NOT let the
  // stale Kardan turn hijack the pick.
  const turn1 = await routeFastPathText({
    senderId,
    text: "lumia aylal medelel awy",
    contextualUserText: "kardan aylal une\nshanghai aylal medelel awy",
    trips: TRIPS,
  });
  assert.doesNotMatch(turn1.matchText, /kardan aylal une/);
  const pending = await getClarificationState(senderId);
  assert.ok(pending, "ambiguity must be captured as clarification state");
  assert.deepEqual(
    [...pending!.candidateTripIds].sort(),
    ["lumia-hanzhou", "lumia-zetgoriin"],
  );

  // Turn 2: the customer answers "shud nislegtein" while a stale Kardan
  // turn still sits in the contextual window. Both offered trips are direct
  // flights, so the honest outcome is a scoped re-clarification between THOSE
  // two — never the Kardan trip, and never a confident pick of one.
  const turn2 = await routeFastPathText({
    senderId,
    text: "shud nislegtein",
    contextualUserText: "kardan aylal une\nshanghai aylal medelel awy\nshud nislegtein",
    trips: TRIPS,
  });
  assert.ok(turn2.scopedClarify, "must re-ask, scoped to the offered candidates");
  assert.deepEqual(
    turn2.scopedClarify!.map((trip) => trip.id).sort(),
    ["lumia-hanzhou", "lumia-zetgoriin"],
  );

  // Turn 3: a discriminating answer picks exactly one offered trip.
  const turn3 = await routeFastPathText({
    senderId,
    text: "усан парктай нь",
    contextualUserText: "усан парктай нь",
    trips: TRIPS,
  });
  assert.equal(turn3.scopedClarify, null);
  assert.match(turn3.matchText, /Лумиа\+Хэлвин шууд нислэгтэй, усан парктай аялал/);
  assert.doesNotMatch(turn3.matchText, /Зэтгорийн хаалга/);
  assert.equal(await getClarificationState(senderId), null, "state cleared after resolution");
});

test("an answer fitting none of the offered candidates drops the clarification (topic change)", async () => {
  const senderId = "route-test-topic-change";
  await clearClarificationState(senderId);
  await routeFastPathText({
    senderId,
    text: "lumia aylal",
    contextualUserText: "lumia aylal",
    trips: TRIPS,
  });
  assert.ok(await getClarificationState(senderId));

  const next = await routeFastPathText({
    senderId,
    text: "kardan une hed ve",
    contextualUserText: "kardan une hed ve",
    trips: TRIPS,
  });
  assert.equal(next.scopedClarify, null);
  assert.match(next.matchText, /kardan une hed ve/);
  // Old Lumia clarification must not linger after the customer moved on.
  const after = await getClarificationState(senderId);
  assert.ok(
    !after || !after.candidateTripIds.includes("lumia-zetgoriin"),
    "stale Lumia clarification must be dropped",
  );
});

test("numbered quick-reply choice resolves against the offered clarification list", async () => {
  const senderId = "route-test-numbered-choice";
  await clearClarificationState(senderId);
  const { setClarificationState } = await import("../src/lib/clarificationState");
  await setClarificationState(senderId, ["lumia-zetgoriin", "lumia-hanzhou"]);

  const routed = await routeFastPathText({
    senderId,
    text: "2. Лумиа+Хэлвин",
    contextualUserText: "kardan aylal une\n2. Лумиа+Хэлвин",
    trips: TRIPS,
  });

  assert.equal(routed.scopedClarify, null);
  assert.match(routed.matchText, /Лумиа\+Хэлвин|Ð›ÑƒÐ¼Ð¸Ð°\+Ð¥ÑÐ»Ð²Ð¸Ð½/);
  assert.equal(await getClarificationState(senderId), null);
});

test("specific combo query escapes stale Velmor ground-trip clarification", async () => {
  const senderId = "route-test-velmor-combo-escape";
  await clearClarificationState(senderId);
  const trips = [
    trip({
      id: "velmor-four-city",
      route_name: "ВЭЛМОР - СЭЛВИН – ПЭЛМАК - ОРМАК – 4 ХОТЫН АЯЛАЛ",
      category: "Газрын аялал",
      extra: { aliases: ["Вэлмор", "Velmor"] },
    }),
    trip({
      id: "kardan-velmor-combo",
      route_name: "Кардан сэрвэн тэнгисийн эрэг+Вэлмор газар нислэг хосолсон аялал",
      category: "Газар нислэг хосолсон",
      extra: { aliases: ["Вэлмор газар нислэг хосолсон", "Кардан Вэлмор"] },
    }),
    trip({
      id: "velmor-naadam-ground",
      route_name: "ВЭЛМОР - СЭЛВИН – ПЭЛМАК - ОРМАК-наадмын амралтаар явах газрын аялал",
      category: "Газрын аялал",
      extra: { aliases: ["Вэлмор газрын аялал", "Velmor land tour"] },
    }),
  ];

  await routeFastPathText({
    senderId,
    text: "Вэлмор аялал хэд вэ?",
    contextualUserText: "Вэлмор аялал хэд вэ?",
    trips,
  });

  const ground = await routeFastPathText({
    senderId,
    text: "Вэлмор газрын аялал байна уу?",
    contextualUserText: "Вэлмор аялал хэд вэ?\nВэлмор газрын аялал байна уу?",
    trips,
  });
  assert.ok(ground.scopedClarify, "ground query can still clarify between ground variants");
  assert.deepEqual(
    ground.scopedClarify!.map((candidate) => candidate.id).sort(),
    ["velmor-four-city", "velmor-naadam-ground"],
  );

  const combo = await routeFastPathText({
    senderId,
    text: "Вэлмор газар нислэг хосолсон аяллын үнэ?",
    contextualUserText:
      "Вэлмор аялал хэд вэ?\nВэлмор газрын аялал байна уу?\nВэлмор газар нислэг хосолсон аяллын үнэ?",
    trips,
  });
  assert.equal(combo.scopedClarify, null);
  assert.match(combo.matchText, /Кардан сэрвэн тэнгисийн эрэг\+Вэлмор газар нислэг хосолсон аялал/);
});

test("filterCandidatesByAttribute matches transliterated attribute answers", () => {
  const both = filterCandidatesByAttribute("shud nislegtein", [TRIPS[1], TRIPS[2]]);
  assert.equal(both.length, 2, "both offered trips are direct flights");
  const one = filterCandidatesByAttribute("усан парктай", [TRIPS[1], TRIPS[2]]);
  assert.equal(one.length, 1);
  assert.equal(one[0].id, "lumia-hanzhou");
  const none = filterCandidatesByAttribute("za", [TRIPS[1], TRIPS[2]]);
  assert.equal(none.length, 0, "low-signal answers must not fake-match");
});

test("context resolves the trip but stale qualifiers are removed from builder input", async () => {
  const senderId = "route-test-canonical-context";
  await clearClarificationState(senderId);
  const previous =
    "✈️ Лумиа + Зэтгорийн хаалга шууд нислэгтэй аялал\n💰 7 сарын үнэ: 3,601,000₮";
  const current = "8 сарын хүүхдийн үнэ?";
  const routed = await routeFastPathText({
    senderId,
    text: current,
    contextualUserText: `${previous}\n${current}`,
    trips: TRIPS,
  });

  assert.match(routed.matchText, /^Лумиа \+ Зэтгорийн хаалга шууд нислэгтэй аялал/);
  assert.match(routed.matchText, /8 сарын хүүхдийн үнэ/);
  assert.doesNotMatch(routed.matchText, /7 сарын үнэ|3,601,000/);
});

// ── Hailaar follow-up regressions: duration digits + date answers ──────────
const HAILAAR_TRIPS: TravelTrip[] = [
  trip({
    id: "hailaar-4d",
    route_name: "Торвал Нордэнын аялал - 4 өдөр 3 шөнө",
    duration_text: "4 өдөр / 3 шөнө",
    departure_dates: ["Баасан гариг бүр", "8 сарын 21", "8 сарын 28"],
  }),
  trip({
    id: "hailaar-5d",
    route_name: "Торвал Нордэнын аялал - 5 өдөр 4 шөнө",
    duration_text: "5 өдөр / 4 шөнө",
    departure_dates: ["Даваа гариг болгон", "8 сарын 17", "8 сарын 24"],
  }),
  trip({
    id: "hailaar-chichihar",
    route_name: "ТОРВАЛ ЛЭМРИНЫН АЯЛАЛ-шууд нислэгтэй",
    duration_text: "4 шөнө 5 өдөр",
    departure_dates: ["7 сарын 27", "8 сарын 10"],
  }),
];

test("duration answer with a digit narrows to the matching candidate", async () => {
  const senderId = "route-test-duration-digit";
  await clearClarificationState(senderId);
  const { setClarificationState } = await import("../src/lib/clarificationState");
  await setClarificationState(senderId, HAILAAR_TRIPS.map((t) => t.id));

  const routed = await routeFastPathText({
    senderId,
    text: "5 өдөр нь",
    contextualUserText: "5 өдөр нь",
    trips: HAILAAR_TRIPS,
  });

  // "5" is the discriminating signal: the 4-day trip must not survive it.
  if (routed.scopedClarify) {
    assert.equal(
      routed.scopedClarify.some((t) => t.id === "hailaar-4d"),
      false,
      "the 4-day trip must be excluded by the digit",
    );
  } else {
    assert.match(routed.matchText, /5 өдөр 4 шөнө/);
  }
});

test("date answer selects the only candidate departing that date", async () => {
  const senderId = "route-test-date-unique";
  await clearClarificationState(senderId);
  const { setClarificationState } = await import("../src/lib/clarificationState");
  // Pending: the 4-day (Fridays + 8/21, 8/28) and Chichihar (7/27, 8/10).
  await setClarificationState(senderId, ["hailaar-4d", "hailaar-chichihar"]);

  const routed = await routeFastPathText({
    senderId,
    text: "8 сарын 28-нд хэд вэ",
    contextualUserText: "8 сарын 28-нд хэд вэ",
    trips: HAILAAR_TRIPS,
  });

  assert.equal(routed.scopedClarify, null);
  assert.match(routed.matchText, /4 өдөр 3 шөнө/);
  const state = await getClarificationState(senderId);
  assert.equal(state, null, "clarification resolved — state must be cleared");
});

test("date answer matching several candidates re-asks scoped with the date echoed", async () => {
  const senderId = "route-test-date-multi";
  await clearClarificationState(senderId);
  const { setClarificationState } = await import("../src/lib/clarificationState");

  // Explicit, non-overlapping departure dates only.
  //
  // This used to lean on "8 сарын 24" being a Monday so it hit the 5-day trip's
  // "Даваа гариг болгон" recurrence and missed the 4-day trip's Fridays — a
  // time bomb, because the same calendar date is a Friday in 2029, at which
  // point both trips matched and this assertion flipped. Weekday recurrence
  // narrowing is covered directly in audit-2026-07-27.test.ts against
  // tripMatchesRequestedDate, so this test does not need to re-derive it from
  // whatever weekday today happens to be.
  const datedTrips: TravelTrip[] = [
    trip({
      id: "route-4d",
      route_name: "Зэрэглээ хотын аялал - 4 өдөр 3 шөнө",
      duration_text: "4 өдөр / 3 шөнө",
      departure_dates: ["8 сарын 21", "8 сарын 28"],
    }),
    trip({
      id: "route-5d",
      route_name: "Зэрэглээ хотын аялал - 5 өдөр 4 шөнө",
      duration_text: "5 өдөр / 4 шөнө",
      departure_dates: ["8 сарын 17", "8 сарын 24"],
    }),
    trip({
      id: "route-direct",
      route_name: "НОМИН АРЛЫН АЯЛАЛ-шууд нислэгтэй",
      duration_text: "4 шөнө 5 өдөр",
      departure_dates: ["7 сарын 27", "8 сарын 10"],
    }),
  ];
  await setClarificationState(senderId, datedTrips.map((t) => t.id));

  const routed = await routeFastPathText({
    senderId,
    text: "8 сарын 24-нд хэд вэ",
    contextualUserText: "8 сарын 24-нд хэд вэ",
    trips: datedTrips,
  });

  // Unique in this fixture → selected directly.
  assert.equal(routed.scopedClarify, null);
  assert.match(routed.matchText, /5 өдөр 4 шөнө/);
});

test("a bare destination word that's ambiguous on its own is not hijacked by an unrelated previous reply", async () => {
  // Real bug (2026-07-17): customer asked about land+flight combo trips
  // ("gazar nisleg hisolson"), got a Eldor combo trip, then sent just
  // "velmor" — a complete, self-sufficient destination name that resolves
  // AMBIGUOUS on its own (several real Velmor trips exist). Because
  // isLikelyContextDependentText treats any 1-2 word message as a follow-up
  // reference, the router let the unrelated Eldor reply's contextual
  // resolution win outright, with no check that Eldor was even one of
  // "velmor"'s own candidates.
  const senderId = "route-test-short-word-not-context-hijacked";
  await clearClarificationState(senderId);
  const eldor = trip({
    id: "eldor-combo",
    route_name: "Эльдор-Газар Нислэг Хосолсон",
    category: "Газар нислэг хосолсон",
  });
  // Two real Velmor-mentioning trips, matching the live catalog shape, so
  // "velmor" resolves AMBIGUOUS on its own — not "verified" — which is what
  // actually made the original bug happen (an ambiguous direct result was
  // silently overridden by the unrelated contextual winner).
  const velmorCombo = trip({
    id: "velmor-combo",
    route_name: "Кардан сэрвэн тэнгисийн эрэг+Вэлмор газар нислэг хосолсон аялал",
    category: "Газар нислэг хосолсон",
    extra: { aliases: ["Вэлмор"] },
  });
  const velmorCruise = trip({
    id: "velmor-cruise",
    route_name: "Усан онгоцны аялал - Ормак - Вэлмор -Дорнэл - Талвин Вирдэн",
    category: "Круйз",
    extra: { aliases: ["Вэлмор круз"] },
  });
  const trips = [eldor, velmorCombo, velmorCruise];
  const previousReply =
    "Эльдор-Газар Нислэг Хосолсон аялал 8 шөнө 9 өдөр үргэлжилнэ.\n\n✈️ Эльдор-Газар Нислэг Хосолсон — 8 шөнө 9 өдөр\n💰 Том хүн: 2,301,000₮";

  const routed = await routeFastPathText({
    senderId,
    text: "velmor",
    contextualUserText: `${previousReply}\nbeejin`,
    trips,
  });

  // Must NOT resolve to the unrelated Eldor trip.
  assert.doesNotMatch(routed.matchText, /Эльдор/);
});

test("a plain greeting is never treated as a context-dependent follow-up", async () => {
  // Real bug (2026-07-22): a returning customer typed just "hi" two days
  // after asking about a trip, and got that trip's stale price/dates
  // re-served instead of a fresh greeting. Root cause: isLikelyContextDependentText's
  // words.length<=2 rule treats EVERY short message as a follow-up
  // reference, with no exception for an actual greeting — which asks
  // nothing and has no context to resolve. This is a wider case of the
  // same bug class as the "velmor"/Eldor fix above: a same-message
  // result (here, "no trip mentioned at all" rather than "ambiguous")
  // must not be silently overridden by an unrelated previous reply.
  const senderId = "route-test-greeting-not-context-hijacked";
  await clearClarificationState(senderId);
  const velmorCombo = trip({
    id: "velmor-combo",
    route_name: "Кардан сэрвэн тэнгисийн эрэг+Вэлмор газар нислэг хосолсон аялал",
    category: "Газар нислэг хосолсон",
  });
  const previousReply =
    "✈️ Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал\n💰 Үнэ: Том хүн 1,270,000₮";

  const routed = await routeFastPathText({
    senderId,
    text: "hi",
    contextualUserText: `${previousReply}\nhi`,
    trips: [velmorCombo],
  });

  assert.equal(routed.matchText, "hi");
});

test("a newly named photo trip beats stale previous photo context", async () => {
  const senderId = "route-test-photo-topic-switch";
  await clearClarificationState(senderId);
  const kardan = trip({
    id: "kardan-combo-photo",
    route_name: "\u041a\u0430\u0440\u0434\u0430\u043d \u0441\u044d\u0440\u0432\u044d\u043d \u0442\u044d\u043d\u0433\u0438\u0441\u0438\u0439\u043d \u044d\u0440\u044d\u0433+\u0412\u044d\u043b\u043c\u043e\u0440 \u0433\u0430\u0437\u0430\u0440 \u043d\u0438\u0441\u043b\u044d\u0433 \u0445\u043e\u0441\u043e\u043b\u0441\u043e\u043d \u0430\u044f\u043b\u0430\u043b",
    extra: {
      aliases: [
        "\u041a\u0430\u0440\u0434\u0430\u043d \u0433\u0430\u0437\u0430\u0440 \u043d\u0438\u0441\u043b\u044d\u0433 \u0445\u043e\u0441\u043e\u043b\u0441\u043e\u043d",
      ],
    },
  });
  const zetgorDirect = trip({
    id: "zetgor-direct-photo",
    route_name: "\u0417\u044d\u0442\u0433\u043e\u0440\u0438\u0439\u043d \u0445\u0430\u0430\u043b\u0433\u0430 - \u0448\u0443\u0443\u0434 \u043d\u0438\u0441\u043b\u044d\u0433\u0442\u044d\u0439",
    extra: { aliases: ["\u041f\u044d\u043b\u0434\u043e\u0440", "Peldor"] },
  });
  const lumiaTenger = trip({
    id: "lumia-zetgor-photo",
    route_name: "\u041b\u0443\u043c\u0438\u0430 + \u0417\u044d\u0442\u0433\u043e\u0440\u0438\u0439\u043d \u0445\u0430\u0430\u043b\u0433\u0430 \u0448\u0443\u0443\u0434 \u043d\u0438\u0441\u043b\u044d\u0433\u0442\u044d\u0439 \u0430\u044f\u043b\u0430\u043b",
    extra: {
      aliases: [
        "\u041b\u0443\u043c\u0438\u0430 \u041f\u044d\u043b\u0434\u043e\u0440",
        "Lumia Peldor",
      ],
    },
  });
  const current = "\u041b\u0443\u043c\u0438\u0430 \u041f\u044d\u043b\u0434\u043e\u0440 \u0437\u0443\u0440\u0430\u0433";
  const stalePrevious =
    "\u2708\ufe0f \u041a\u0430\u0440\u0434\u0430\u043d \u0441\u044d\u0440\u0432\u044d\u043d \u0442\u044d\u043d\u0433\u0438\u0441\u0438\u0439\u043d \u044d\u0440\u044d\u0433+\u0412\u044d\u043b\u043c\u043e\u0440 \u0433\u0430\u0437\u0430\u0440 \u043d\u0438\u0441\u043b\u044d\u0433 \u0445\u043e\u0441\u043e\u043b\u0441\u043e\u043d \u0430\u044f\u043b\u0430\u043b " +
    "\u041f\u043e\u0441\u0442\u0435\u0440 \u0437\u0443\u0440\u0433\u0443\u0443\u0434\u044b\u0433 \u043d\u044c \u0445\u0430\u0432\u0441\u0430\u0440\u0433\u0430\u043b\u0430\u0430.";
  const routed = await routeFastPathText({
    senderId,
    text: current,
    contextualUserText: `${stalePrevious}\n${current}`,
    trips: [kardan, zetgorDirect, lumiaTenger],
  });

  assert.equal(routed.scopedClarify, null);
  assert.equal(routed.matchText, current);
});
