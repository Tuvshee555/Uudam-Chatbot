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
    id: "beidaihe",
    route_name: "ШАР ТЭНГИС БУЮУ БЭЙДАЙХЭ-БЭЭЖИНГИЙН ГАЗРЫН АЯЛАЛ",
    category: "Газрын",
    extra: { aliases: ["Бэйдайхэ", "Beidaihe"] },
  }),
  trip({
    id: "shanghai-tengeriin",
    route_name: "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал",
    category: "Шууд нислэгтэй",
    extra: { aliases: ["Shanghai"] },
  }),
  trip({
    id: "shanghai-hanzhou",
    route_name: "Шанхай+Ханжоу шууд нислэгтэй, усан парктай аялал",
    category: "Шууд нислэгтэй",
    extra: { aliases: ["Shanghai", "Hangzhou"] },
  }),
];

test("LIVE BUG regression: clarification answer can never be hijacked by a stale trip from old turns", async () => {
  const senderId = "route-test-hijack";
  await clearClarificationState(senderId);

  // Turn 1: "shanghai aylal medelel awy" — ambiguous between the two Shanghai
  // trips; the router must remember those candidates and must NOT let the
  // stale Beidaihe turn hijack the pick.
  const turn1 = await routeFastPathText({
    senderId,
    text: "shanghai aylal medelel awy",
    contextualUserText: "beidaihe aylal une\nshanghai aylal medelel awy",
    trips: TRIPS,
  });
  assert.doesNotMatch(turn1.matchText, /beidaihe aylal une/);
  const pending = await getClarificationState(senderId);
  assert.ok(pending, "ambiguity must be captured as clarification state");
  assert.deepEqual(
    [...pending!.candidateTripIds].sort(),
    ["shanghai-hanzhou", "shanghai-tengeriin"],
  );

  // Turn 2: the customer answers "shud nislegtein" while a stale Beidaihe
  // turn still sits in the contextual window. Both offered trips are direct
  // flights, so the honest outcome is a scoped re-clarification between THOSE
  // two — never the Beidaihe trip, and never a confident pick of one.
  const turn2 = await routeFastPathText({
    senderId,
    text: "shud nislegtein",
    contextualUserText: "beidaihe aylal une\nshanghai aylal medelel awy\nshud nislegtein",
    trips: TRIPS,
  });
  assert.ok(turn2.scopedClarify, "must re-ask, scoped to the offered candidates");
  assert.deepEqual(
    turn2.scopedClarify!.map((trip) => trip.id).sort(),
    ["shanghai-hanzhou", "shanghai-tengeriin"],
  );

  // Turn 3: a discriminating answer picks exactly one offered trip.
  const turn3 = await routeFastPathText({
    senderId,
    text: "усан парктай нь",
    contextualUserText: "усан парктай нь",
    trips: TRIPS,
  });
  assert.equal(turn3.scopedClarify, null);
  assert.match(turn3.matchText, /Шанхай\+Ханжоу шууд нислэгтэй, усан парктай аялал/);
  assert.doesNotMatch(turn3.matchText, /Тэнгэрийн хаалга/);
  assert.equal(await getClarificationState(senderId), null, "state cleared after resolution");
});

test("an answer fitting none of the offered candidates drops the clarification (topic change)", async () => {
  const senderId = "route-test-topic-change";
  await clearClarificationState(senderId);
  await routeFastPathText({
    senderId,
    text: "shanghai aylal",
    contextualUserText: "shanghai aylal",
    trips: TRIPS,
  });
  assert.ok(await getClarificationState(senderId));

  const next = await routeFastPathText({
    senderId,
    text: "beidaihe une hed ve",
    contextualUserText: "beidaihe une hed ve",
    trips: TRIPS,
  });
  assert.equal(next.scopedClarify, null);
  assert.match(next.matchText, /beidaihe une hed ve/);
  // Old Shanghai clarification must not linger after the customer moved on.
  const after = await getClarificationState(senderId);
  assert.ok(
    !after || !after.candidateTripIds.includes("shanghai-tengeriin"),
    "stale Shanghai clarification must be dropped",
  );
});

test("specific combo query escapes stale Beijing ground-trip clarification", async () => {
  const senderId = "route-test-beijing-combo-escape";
  await clearClarificationState(senderId);
  const trips = [
    trip({
      id: "beijing-four-city",
      route_name: "БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН – 4 ХОТЫН АЯЛАЛ",
      category: "Газрын аялал",
      extra: { aliases: ["Бээжин", "Beijing"] },
    }),
    trip({
      id: "beidaihe-beijing-combo",
      route_name: "Бэйдайхэ шар тэнгисийн эрэг+Бээжин газар нислэг хосолсон аялал",
      category: "Газар нислэг хосолсон",
      extra: { aliases: ["Бээжин газар нислэг хосолсон", "Бэйдайхэ Бээжин"] },
    }),
    trip({
      id: "beijing-naadam-ground",
      route_name: "БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН-наадмын амралтаар явах газрын аялал",
      category: "Газрын аялал",
      extra: { aliases: ["Бээжин газрын аялал", "Beijing land tour"] },
    }),
  ];

  await routeFastPathText({
    senderId,
    text: "Бээжин аялал хэд вэ?",
    contextualUserText: "Бээжин аялал хэд вэ?",
    trips,
  });

  const ground = await routeFastPathText({
    senderId,
    text: "Бээжин газрын аялал байна уу?",
    contextualUserText: "Бээжин аялал хэд вэ?\nБээжин газрын аялал байна уу?",
    trips,
  });
  assert.ok(ground.scopedClarify, "ground query can still clarify between ground variants");
  assert.deepEqual(
    ground.scopedClarify!.map((candidate) => candidate.id).sort(),
    ["beijing-four-city", "beijing-naadam-ground"],
  );

  const combo = await routeFastPathText({
    senderId,
    text: "Бээжин газар нислэг хосолсон аяллын үнэ?",
    contextualUserText:
      "Бээжин аялал хэд вэ?\nБээжин газрын аялал байна уу?\nБээжин газар нислэг хосолсон аяллын үнэ?",
    trips,
  });
  assert.equal(combo.scopedClarify, null);
  assert.match(combo.matchText, /Бэйдайхэ шар тэнгисийн эрэг\+Бээжин газар нислэг хосолсон аялал/);
});

test("filterCandidatesByAttribute matches transliterated attribute answers", () => {
  const both = filterCandidatesByAttribute("shud nislegtein", [TRIPS[1], TRIPS[2]]);
  assert.equal(both.length, 2, "both offered trips are direct flights");
  const one = filterCandidatesByAttribute("усан парктай", [TRIPS[1], TRIPS[2]]);
  assert.equal(one.length, 1);
  assert.equal(one[0].id, "shanghai-hanzhou");
  const none = filterCandidatesByAttribute("za", [TRIPS[1], TRIPS[2]]);
  assert.equal(none.length, 0, "low-signal answers must not fake-match");
});

test("context resolves the trip but stale qualifiers are removed from builder input", async () => {
  const senderId = "route-test-canonical-context";
  await clearClarificationState(senderId);
  const previous =
    "✈️ Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал\n💰 7 сарын үнэ: 3,590,000₮";
  const current = "8 сарын хүүхдийн үнэ?";
  const routed = await routeFastPathText({
    senderId,
    text: current,
    contextualUserText: `${previous}\n${current}`,
    trips: TRIPS,
  });

  assert.match(routed.matchText, /^Шанхай \+ Тэнгэрийн хаалга шууд нислэгтэй аялал/);
  assert.match(routed.matchText, /8 сарын хүүхдийн үнэ/);
  assert.doesNotMatch(routed.matchText, /7 сарын үнэ|3,590,000/);
});

// ── Hailaar follow-up regressions: duration digits + date answers ──────────
const HAILAAR_TRIPS: TravelTrip[] = [
  trip({
    id: "hailaar-4d",
    route_name: "Хайлаар Манжуурын аялал - 4 өдөр 3 шөнө",
    duration_text: "4 өдөр / 3 шөнө",
    departure_dates: ["Баасан гариг бүр", "8 сарын 21", "8 сарын 28"],
  }),
  trip({
    id: "hailaar-5d",
    route_name: "Хайлаар Манжуурын аялал - 5 өдөр 4 шөнө",
    duration_text: "5 өдөр / 4 шөнө",
    departure_dates: ["Даваа гариг болгон", "8 сарын 17", "8 сарын 24"],
  }),
  trip({
    id: "hailaar-chichihar",
    route_name: "ХАЙЛААР ЧИЧИХАРЫН АЯЛАЛ-шууд нислэгтэй",
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
  await setClarificationState(senderId, HAILAAR_TRIPS.map((t) => t.id));

  // 2026-08-24 is a Monday: matches the 5-day trip explicitly AND via its
  // "Даваа гариг болгон" recurrence — but not Chichihar (7/27, 8/10) and not
  // the 4-day (Fridays + 8/21, 8/28).
  const routed = await routeFastPathText({
    senderId,
    text: "8 сарын 24-нд хэд вэ",
    contextualUserText: "8 сарын 24-нд хэд вэ",
    trips: HAILAAR_TRIPS,
  });

  // Unique in this fixture → selected directly.
  assert.equal(routed.scopedClarify, null);
  assert.match(routed.matchText, /5 өдөр 4 шөнө/);
});

test("a bare destination word that's ambiguous on its own is not hijacked by an unrelated previous reply", async () => {
  // Real bug (2026-07-17): customer asked about land+flight combo trips
  // ("gazar nisleg hisolson"), got a Chunchin combo trip, then sent just
  // "beejin" — a complete, self-sufficient destination name that resolves
  // AMBIGUOUS on its own (several real Beijing trips exist). Because
  // isLikelyContextDependentText treats any 1-2 word message as a follow-up
  // reference, the router let the unrelated Chunchin reply's contextual
  // resolution win outright, with no check that Chunchin was even one of
  // "beejin"'s own candidates.
  const senderId = "route-test-short-word-not-context-hijacked";
  await clearClarificationState(senderId);
  const chunchin = trip({
    id: "chunchin-combo",
    route_name: "Чунчин-Газар Нислэг Хосолсон",
    category: "Газар нислэг хосолсон",
  });
  // Two real Beijing-mentioning trips, matching the live catalog shape, so
  // "beejin" resolves AMBIGUOUS on its own — not "verified" — which is what
  // actually made the original bug happen (an ambiguous direct result was
  // silently overridden by the unrelated contextual winner).
  const beijingCombo = trip({
    id: "beijing-combo",
    route_name: "Бэйдайхэ шар тэнгисийн эрэг+Бээжин газар нислэг хосолсон аялал",
    category: "Газар нислэг хосолсон",
    extra: { aliases: ["Бээжин"] },
  });
  const beijingCruise = trip({
    id: "beijing-cruise",
    route_name: "Усан онгоцны аялал - Эрээн - Бээжин -Тяньжин - Чежү Пусан",
    category: "Круйз",
    extra: { aliases: ["Бээжин круз"] },
  });
  const trips = [chunchin, beijingCombo, beijingCruise];
  const previousReply =
    "Чунчин-Газар Нислэг Хосолсон аялал 8 шөнө 9 өдөр үргэлжилнэ.\n\n✈️ Чунчин-Газар Нислэг Хосолсон — 8 шөнө 9 өдөр\n💰 Том хүн: 2,290,000₮";

  const routed = await routeFastPathText({
    senderId,
    text: "beejin",
    contextualUserText: `${previousReply}\nbeejin`,
    trips,
  });

  // Must NOT resolve to the unrelated Chunchin trip.
  assert.doesNotMatch(routed.matchText, /Чунчин/);
});

test("a plain greeting is never treated as a context-dependent follow-up", async () => {
  // Real bug (2026-07-22): a returning customer typed just "hi" two days
  // after asking about a trip, and got that trip's stale price/dates
  // re-served instead of a fresh greeting. Root cause: isLikelyContextDependentText's
  // words.length<=2 rule treats EVERY short message as a follow-up
  // reference, with no exception for an actual greeting — which asks
  // nothing and has no context to resolve. This is a wider case of the
  // same bug class as the "beejin"/Chunchin fix above: a same-message
  // result (here, "no trip mentioned at all" rather than "ambiguous")
  // must not be silently overridden by an unrelated previous reply.
  const senderId = "route-test-greeting-not-context-hijacked";
  await clearClarificationState(senderId);
  const beijingCombo = trip({
    id: "beijing-combo",
    route_name: "Бэйдайхэ шар тэнгисийн эрэг+Бээжин газар нислэг хосолсон аялал",
    category: "Газар нислэг хосолсон",
  });
  const previousReply =
    "✈️ Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал\n💰 Үнэ: Том хүн 2,150,000₮";

  const routed = await routeFastPathText({
    senderId,
    text: "hi",
    contextualUserText: `${previousReply}\nhi`,
    trips: [beijingCombo],
  });

  assert.equal(routed.matchText, "hi");
});
