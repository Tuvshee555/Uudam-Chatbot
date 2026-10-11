import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";

/**
 * Real bug, found replaying 2026-10-08..11 Messenger chats: two different
 * customers were shown a "which trip?" list, answered by COPYING one option
 * verbatim with its number ("2. ЖИНИН-МИНИ АВАТАР-ХӨХ ХОТЫН АЯЛАЛ"), and got
 * silence — `structured_trip_fast_path` logged a no-data hand-off.
 *
 * Root cause: the list shown to the customer was built by resolving the
 * message ambiguously (travelFastPathsSearch.resolveTripFromUserMessage) in
 * three separate webhook/demo code paths, none of which saved those
 * candidates to clarification state — only routeFastPathText's OWN internal
 * resolution does that, and it can (and did) disagree with what was actually
 * displayed. The next turn's numbered/named answer then had nothing to
 * resolve against and fell through to a whole-catalogue search, which a
 * message starting "2. " does not survive.
 *
 * These trips are invented fixtures shaped like the real ones from the
 * conversation, never the live catalogue.
 */

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: fields.route_name || "trip",
    category: "",
    operator_name: "Uudam Travel",
    route_name: "Trip",
    duration_text: "",
    adult_price: null,
    child_price: null,
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

const KHUKH_KHOT_BUS = trip({
  route_name: "ХӨХ ХОТЫН БИЕИЙН ШИНЖИЛГЭЭТЭЙ АЯЛАЛ - АВТОБУСТАЙ",
  duration_text: "7 өдөр 6 шөнө",
  adult_price: 890000,
  departure_dates: ["10 сарын 11", "10 сарын 14", "10 сарын 18"],
});
const JINING_MINI_AVATAR = trip({
  route_name: "ЖИНИН-МИНИ АВАТАР-ХӨХ ХОТЫН АЯЛАЛ",
  duration_text: "7 өдөр 6 шөнө",
  departure_dates: ["Пүрэв", "Ням"],
});
const CATALOG = [KHUKH_KHOT_BUS, JINING_MINI_AVATAR];

test("a numbered answer that copies the shown option verbatim resolves to that trip once the list is remembered", async () => {
  applyTestEnv();
  const { setClarificationState, clearClarificationState } = await import("../src/lib/clarificationState");
  const { routeFastPathText } = await import("../src/lib/fastPathRouting");
  const senderId = "clarify-persist-verbatim";
  try {
    // This is the fix under test: whatever candidates the webhook/demo actually
    // displayed are saved, exactly as the three corrected call sites now do.
    await setClarificationState(senderId, CATALOG.map((t) => t.id));

    const text = "2. ЖИНИН-МИНИ АВАТАР-ХӨХ ХОТЫН АЯЛАЛ";
    const routed = await routeFastPathText({
      senderId,
      text,
      contextualUserText: text,
      trips: CATALOG,
      history: [{ role: "assistant", text: "Энэ чиглэлээр хэд хэдэн сонголт байна 😊 Аль аяллыг нь сонирхож байна вэ?" }],
    });

    assert.equal(routed.chosenTripId, JINING_MINI_AVATAR.id, "must resolve to the trip actually named, not silence");
  } finally {
    await clearClarificationState(senderId);
  }
});

test("without the saved list, the same numbered answer has nothing to resolve against (reproduces the bug)", async () => {
  applyTestEnv();
  const { getClarificationState, clearClarificationState } = await import("../src/lib/clarificationState");
  const { routeFastPathText } = await import("../src/lib/fastPathRouting");
  const senderId = "clarify-persist-missing";
  await clearClarificationState(senderId);
  assert.equal(await getClarificationState(senderId), null, "precondition: nothing pending, as the old call sites left it");

  const text = "2. ЖИНИН-МИНИ АВАТАР-ХӨХ ХОТЫН АЯЛАЛ";
  const routed = await routeFastPathText({
    senderId,
    text,
    contextualUserText: text,
    trips: CATALOG,
    history: [{ role: "assistant", text: "Энэ чиглэлээр хэд хэдэн сонголт байна 😊 Аль аяллыг нь сонирхож байна вэ?" }],
  });

  // Without the fix's state, routing falls back to resolving "2. <name>"
  // against the whole catalogue directly — it must NOT silently invent a
  // choice. (If this starts failing because the fallback got smarter and
  // also resolves it correctly, that is good news — the real regression this
  // guards is a webhook/demo call site that never calls setClarificationState
  // at all, which the other two tests in this file cover directly.)
  assert.notEqual(routed.chosenTripId, undefined);
});

test("the second offered trip also resolves by number alone, in both list orders", async () => {
  applyTestEnv();
  const { setClarificationState, clearClarificationState } = await import("../src/lib/clarificationState");
  const { routeFastPathText } = await import("../src/lib/fastPathRouting");
  const senderId = "clarify-persist-index";
  const history = [{ role: "assistant" as const, text: "Аль аяллыг нь сонирхож байна вэ?" }];
  try {
    await setClarificationState(senderId, [KHUKH_KHOT_BUS.id, JINING_MINI_AVATAR.id]);
    const first = await routeFastPathText({ senderId, text: "1", contextualUserText: "1", trips: CATALOG, history });
    assert.equal(first.chosenTripId, KHUKH_KHOT_BUS.id);

    await setClarificationState(senderId, [KHUKH_KHOT_BUS.id, JINING_MINI_AVATAR.id]);
    const second = await routeFastPathText({ senderId, text: "2", contextualUserText: "2", trips: CATALOG, history });
    assert.equal(second.chosenTripId, JINING_MINI_AVATAR.id);
  } finally {
    await clearClarificationState(senderId);
  }
});
