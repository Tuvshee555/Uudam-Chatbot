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
