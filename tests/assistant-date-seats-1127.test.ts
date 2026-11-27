import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import { agentDeps, NOW, scriptedChat, TRIPS, VERSION } from "./helpers/agentFixtures";

applyTestEnv();

/**
 * One date's own seat count (2026-11-27): the admin types it in the chatbot admin and the website admin, and the AI
 * assistant takes it in words («12/2-нд 5 суудал үлдсэн»). The assistant's action is set_date_state with `seats`
 * and no state: 0 closes the date, seats on a full date reopen it, a few-seats flag only comes from «цөөн суудал».
 * Scripted tool calls, invented trips (tests/helpers/agentFixtures), no model and no database.
 */

type Action = Record<string, unknown> & { action: string; trip_id: string; summary: string };

async function propose(instruction: string, actions: Array<Record<string, unknown>>, trips = TRIPS) {
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const script = scriptedChat([
    () => [{ name: "get_trip", args: { trip_id: "t-alpha" } }],
    () => [{ name: "propose_changes", args: { reply_text: "", actions } }],
  ]);
  const result = await runAgent({ instruction, trips, today: NOW, deps: agentDeps(script.chat) });
  return { ...result, script };
}

const proposalOf = (outcome: { kind: string }) => {
  assert.equal(outcome.kind, "proposal", JSON.stringify(outcome));
  return (outcome as unknown as { proposal: { actions: Action[]; conflicts: string[] } }).proposal;
};

test("«12/2-нд 5 суудал үлдсэн» becomes a seat-count action with no state, shown on the card", async () => {
  const result = await propose("альфа 12/2-нд 5 суудал үлдсэн", [{ action: "set_date_state", trip_id: "t-alpha", date: "2098-12-02", seats: 5, summary: "" }]);
  const [action] = proposalOf(result.outcome).actions;
  assert.equal(action.action, "set_date_state");
  assert.equal(action.seats, 5);
  assert.ok(!("state" in action), "the count alone: no state is invented");
  assert.equal(action.expected_updated_at, VERSION);
  assert.equal(action.observed_status, "OPEN", "the day as the proposal saw it, so a later seat button is not overwritten");
  // The fixture's 12/2 holds 10 seats left: the card shows the change from what the website has now.
  assert.match(action.summary, /12\/2: үлдсэн суудал 10 → 5$/);
});

test("0 seats left reads as a full date on the card; seats typed with «цөөн суудал» carry both", async () => {
  const none = await propose("альфа 12/2 0 суудал үлдсэн", [{ action: "set_date_state", trip_id: "t-alpha", date: "2098-12-02", seats: 0, summary: "" }]);
  const [zero] = proposalOf(none.outcome).actions;
  assert.equal(zero.seats, 0);
  assert.match(zero.summary, /12\/2: Нээлттэй → Дүүрсэн, үлдсэн суудал 10 → 0$/);

  const both = await propose("альфа 12/9 цөөн суудал, 3 суудал үлдсэн", [{ action: "set_date_state", trip_id: "t-alpha", date: "2098-12-09", state: "low", seats: 3, summary: "" }]);
  const [low] = proposalOf(both.outcome).actions;
  assert.deepEqual([low.state, low.seats], ["low", 3]);
  assert.match(low.summary, /12\/9: Нээлттэй → Цөөн суудал, үлдсэн суудал (?:\d+|—) → 3$/);
});

test("a count that contradicts the state, or is not a count, never reaches a card", async () => {
  for (const [change, reason] of [
    [{ state: "full", seats: 4 }, /4 суудал үлдсэн бол/],
    [{ state: "open", seats: 0 }, /0 суудал үлдсэн бол/],
    [{ seats: 900 }, /0–200/],
  ] as const) {
    const result = await propose("альфа 12/2 суудал", [{ action: "set_date_state", trip_id: "t-alpha", date: "2098-12-02", summary: "", ...change }]);
    // The refusal goes back to the model once (script runs out: its second round has no step), then it is shown.
    const text = JSON.stringify(result.outcome);
    assert.doesNotMatch(text, /"kind":"proposal"/, JSON.stringify(change));
    assert.match(text + JSON.stringify(result.script), reason, JSON.stringify(change));
  }
});

test("the same count again is «already so», not a second card", async () => {
  const { trip } = await import("./helpers/agentFixtures");
  const counted = trip({
    id: "t-counted", route_name: "ТООЛСОН ТУРШИЛТЫН АЯЛАЛ", departure_dates: ["2098-12-02"],
    extra: { website_departure_availability: [{ date: "2098-12-02", status: "OPEN", seatsLeft: 6 }] },
  });
  const { runAgent } = await import("../src/lib/assistantAgent/agent");
  const script = scriptedChat([
    () => [{ name: "get_trip", args: { trip_id: "t-counted" } }],
    () => [{ name: "propose_changes", args: { reply_text: "", actions: [{ action: "set_date_state", trip_id: "t-counted", date: "2098-12-02", seats: 6, summary: "" }] } }],
  ]);
  const result = await runAgent({ instruction: "тоолсон 12/2 6 суудал үлдсэн", trips: [...TRIPS, counted], today: NOW, deps: agentDeps(script.chat) });
  assert.notEqual(result.outcome.kind, "proposal", "nothing to change");
});

test("the tool schema offers `seats`, and the prompt teaches «үлдсэн суудал» as a count, not a flag", async () => {
  const { AGENT_TOOLS } = await import("../src/lib/assistantAgent/tools");
  const tool = AGENT_TOOLS.find((entry) => entry.function.name === "propose_changes") as unknown as { function: { parameters: { properties: { actions: { items: { properties: Record<string, { type?: string; minimum?: number }> } } } } } };
  const props = tool.function.parameters.properties.actions.items.properties;
  assert.equal(props.seats.type, "integer");
  assert.equal(props.seats.minimum, 0);
  const { buildSystemPrompt } = await import("../src/lib/assistantAgent/prompt");
  assert.match(buildSystemPrompt(), /SEAT COUNT/);
});
