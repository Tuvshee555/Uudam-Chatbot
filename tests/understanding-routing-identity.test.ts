import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import { correctionsCatalog, landFamily } from "./helpers/understandingRoutingCatalogs";
import { contrastCandidates, detectContrastCue } from "../src/lib/tripContrast";
import { identityWordsOf, isBareMention, pointsBackAtTrip, verdictAgainstAnchor } from "../src/lib/tripIdentity";
import { customerTripEvidence } from "../src/lib/tripUnderstanding";
import { getRecentTripIds, getTripSelection, setTripSelection } from "../src/lib/tripSelectionState";
import type { TravelTrip } from "../src/lib/travelTypes";

applyTestEnv({ REDIS_STATE_ENABLED: "false" });

/**
 * The pieces behind "keep answering about the trip the customer is on": what counts as a NEW trip
 * identity, what is only a place the trip already has or a way of travelling, what "not that one"
 * points at, and the short stack of trips the customer was on. Invented data only.
 */
const trips = landFamily as unknown as TravelTrip[];
const byId = (id: string) => trips.find((trip) => trip.id === id)!;
const selected = byId("sel");

test("identity words exclude the way of travelling and keep the places", () => {
  const words = identityWordsOf("Эрдэнээс нисэх онгоцоор явах шууд галт тэрэг");
  assert.ok(words.length >= 1, "the town is an identity word");
  for (const attribute of ["нисэх", "онгоцоор", "шууд", "галт", "тэрэг"]) {
    assert.ok(!words.some((word) => word.startsWith(attribute.slice(0, 3))), `${attribute} is never identity: ${words.join(",")}`);
  }
});

test("a place the selected trip holds is not new identity; a place only another trip has is", () => {
  const far = byId("far");
  for (const text of ["Эрдэнээс нисэх үү", "Эрдэнээс буцах уу", "erdenees nisekh uu", "Эрдэн хотод хэд хононо вэ"]) {
    assert.equal(verdictAgainstAnchor(text, [far], [selected], trips).kind, "stay", text);
  }
  for (const text of ["Волдар руу нисэж болох уу", "voldar ruu nisj bolh uu", "Волдар хот"]) {
    assert.equal(verdictAgainstAnchor(text, [far], [selected], trips).kind, "switch", text);
  }
  // The trip's complete title typed in full is a switch even when its words overlap the current trip.
  assert.equal(verdictAgainstAnchor("ВОЛДАР ХОТЫН АЯЛАЛ – ЭРДЭНЭЭС НИСЛЭГТЭЙ", [far], [selected], trips).kind, "switch");
});

test("a bare destination is a request for its trips, a question is not", () => {
  assert.equal(isBareMention("Эрдэн", trips), true);
  assert.equal(isBareMention("Эрдэн аялал байна уу", trips), true);
  assert.equal(isBareMention("Эрдэнээс нисэх үү", trips), false);
  assert.equal(isBareMention("Эрдэн хотод хэд хононо вэ", trips), false);
});

test("'can I ...?' is not a word pointing back at a trip", () => {
  for (const text of ["Бартер эсвэл гэрээгээр төлж болох уу", "Картаар төлж болох уу", "Хэсэгчлэн төлж болно оо"]) {
    assert.equal(pointsBackAtTrip(text), false, text);
  }
  for (const text of ["тэр аяллын үнэ хэд вэ", "энэ аялал хэзээ гарах вэ", "үнэ хэд вэ", "хөтөлбөр нь"]) {
    assert.equal(pointsBackAtTrip(text), true, text);
  }
});

test("contrast cues: 'not that one, the other' in Cyrillic, Latin and with the ending, but not an everyday 'нөгөө'", () => {
  for (const [text, cue] of [["Өмнөх аяллынх биш, нөгөө далайтай нь", "previous"], ["Энэ аялал биш", "not_this"], ["Эхний аяллын үнэ", "first"],
    ["nogoo aylal ni", "other"], ["omnoh aylal bish", "previous"], ["Тэр биш нөгөөх нь"]] as Array<[string, string?]>) {
    if (cue) assert.equal(detectContrastCue(text), cue, text);
    else assert.notEqual(detectContrastCue(text), null, text);
  }
  for (const text of ["нөгөөдөр явах уу", "энэ аяллын үнэ", "Үнэ хэд вэ", "Эрдэнээс нисэх үү"]) assert.equal(detectContrastCue(text), null, text);
});

test("a contrast cue resolves among the other trips, narrowed by a kind word, preferring the ones shown", () => {
  const catalog = correctionsCatalog as unknown as TravelTrip[];
  const pick = (text: string, selectedIds: string[], stack: string[]) => contrastCandidates({ text, catalog, selectedIds, stack })?.tripIds;
  // The sea kind narrows to the sea trips; the one shown before is preferred.
  assert.deepEqual(pick("Өмнөх биш, нөгөө далайтай аяллын үнэ", ["city"], ["seaB", "seaA"]), ["seaB"]);
  // No kind word: the trip shown before (first = the oldest of the stack).
  assert.deepEqual(pick("Эхний аяллын үнэ", ["city"], ["seaA", "verdan"]), ["verdan"]);
  assert.deepEqual(pick("Өмнөх аялал руугаа буцъя", ["city"], ["seaA"]), ["seaA"]);
  // Nothing was shown and no kind is named: it cannot be resolved (the caller keeps its own evidence).
  assert.equal(pick("Өмнөх аялал руугаа буцъя", ["city"], []), undefined);
  // The selected trip is never the answer.
  assert.ok(!pick("Нөгөө далайтай аялал", ["seaA"], ["seaA"])?.includes("seaA"));
});

test("evidence: the selection is the default, the stack answers a correction, a thank-you names no trip", () => {
  const selection = { tripId: "sel", date: null, hotel: null, package: null, passengers: [], dateScope: null } as never;
  const evidence = (text: string, extra: Record<string, unknown> = {}) => customerTripEvidence({ text, history: [], trips, selection, ...extra });
  assert.deepEqual(evidence("Эрдэнээс нисэх үү"), { source: "selection", tripIds: ["sel"] });
  assert.deepEqual(evidence("2 том хүн"), { source: "selection", tripIds: ["sel"] });
  assert.equal(evidence("Волдар руу нисэж болох уу").tripIds[0], "far");
  const back = customerTripEvidence({ text: "Өмнөх биш, нөгөө аялал", history: [], trips, selection, recentTripIds: ["isl"] });
  assert.deepEqual(back, { source: "current", tripIds: ["isl"] });
  // Without a selection or a list, earlier turns count only for a follow-up.
  const history = [{ role: "user" as const, text: "Лумор Саривана аялал" }, { role: "assistant" as const, text: "..." }];
  assert.equal(customerTripEvidence({ text: "barter awdag u", history, trips }).source, "none");
  assert.equal(customerTripEvidence({ text: "үнэ хэд вэ", history, trips }).source, "history");
});

test("the recent-trips stack: last three, newest first, never the selected trip", async () => {
  const sender = "identity-stack";
  const sel = (tripId: string) => ({ tripId, date: null, hotel: null, package: null, passengers: [], dateScope: null }) as never;
  for (const id of ["a", "b", "c", "d", "e"]) await setTripSelection(sender, sel(id));
  assert.equal((await getTripSelection(sender))?.tripId, "e");
  assert.deepEqual(await getRecentTripIds(sender), ["d", "c", "b"]);
  // Going back to a trip moves it out of the stack and puts the one just left in.
  await setTripSelection(sender, sel("c"));
  assert.deepEqual(await getRecentTripIds(sender), ["e", "d", "b"]);
  // The same trip again changes nothing about the stack.
  await setTripSelection(sender, sel("c"));
  assert.deepEqual(await getRecentTripIds(sender), ["e", "d", "b"]);
  await setTripSelection(sender, null);
  assert.deepEqual(await getRecentTripIds(sender), []);
});
