import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type {
  FlowDoc,
  FlowEffects,
  FlowRuntimeState,
} from "../src/lib/flowEngine";

// The flow engine imports redisState, which validates env at load time, so we
// apply the test env then dynamically import inside each test (matching the
// project's other env-dependent tests). With REDIS_STATE_ENABLED=false the
// engine uses its in-memory fallback — no live Redis needed.
async function loadEngine() {
  applyTestEnv();
  return import("../src/lib/flowEngine");
}

/* ---- test helpers ---- */
type Sent = { kind: "text" | "image" | "quick" | "owner" | "lead"; payload: string };

function recorder() {
  const sent: Sent[] = [];
  const effects: FlowEffects = {
    sendText: async (t) => {
      sent.push({ kind: "text", payload: t });
    },
    sendImage: async (u) => {
      sent.push({ kind: "image", payload: u });
    },
    sendQuickReplies: async (t, labels) => {
      sent.push({ kind: "quick", payload: `${t}|${labels.join(",")}` });
    },
    notifyOwner: async (m) => {
      sent.push({ kind: "owner", payload: m });
    },
    captureLead: async (s) => {
      sent.push({ kind: "lead", payload: JSON.stringify(s.fields) });
    },
  };
  return { sent, effects };
}

/* ---- matchKeyword ---- */
test("matchKeyword honors match types", async () => {
  const { matchKeyword } = await loadEngine();
  assert.equal(matchKeyword("захиалах хүсэж байна", ["захиал"], "contains"), true);
  assert.equal(matchKeyword("захиалах", ["захиал"], "exact"), false);
  assert.equal(matchKeyword("захиал", ["захиал"], "exact"), true);
  assert.equal(matchKeyword("захиалах одоо", ["захиал"], "starts_with"), true);
  assert.equal(matchKeyword("одоо захиал", ["захиал"], "ends_with"), true);
  assert.equal(matchKeyword("сайн байна", ["захиал"], "contains"), false);
});

/* ---- findTriggeredFlow ---- */
test("findTriggeredFlow returns the node after a matching trigger", async () => {
  const { findTriggeredFlow } = await loadEngine();
  const doc: FlowDoc = {
    id: "f1",
    name: "Booking",
    enabled: true,
    nodes: [
      {
        id: "t1",
        position: { x: 0, y: 0 },
        data: { kind: "trigger", triggerType: "keyword", keywords: ["захиал"], matchType: "contains" },
      },
      { id: "m1", position: { x: 0, y: 100 }, data: { kind: "message", text: "Сайн уу" } },
    ],
    edges: [{ id: "e1", source: "t1", target: "m1" }],
  };
  const hit = findTriggeredFlow("би захиалах гэсэн юм", [doc]);
  assert.ok(hit);
  assert.equal(hit?.startNodeId, "m1");
});

test("findTriggeredFlow skips disabled flows", async () => {
  const { findTriggeredFlow } = await loadEngine();
  const doc: FlowDoc = {
    id: "f1",
    name: "x",
    enabled: false,
    nodes: [
      {
        id: "t1",
        position: { x: 0, y: 0 },
        data: { kind: "trigger", triggerType: "keyword", keywords: ["захиал"] },
      },
      { id: "m1", position: { x: 0, y: 0 }, data: { kind: "message", text: "x" } },
    ],
    edges: [{ id: "e1", source: "t1", target: "m1" }],
  };
  assert.equal(findTriggeredFlow("захиалах", [doc]), null);
});

/* ---- message + quick replies ---- */
test("runFlowFrom sends a message and completes", async () => {
  const { runFlowFrom, newRuntimeState } = await loadEngine();
  const { sent, effects } = recorder();
  const doc: FlowDoc = {
    id: "f",
    name: "n",
    enabled: true,
    nodes: [{ id: "n1", position: { x: 0, y: 0 }, data: { kind: "message", text: "Тавтай морил" } }],
    edges: [],
  };
  const outcome = await runFlowFrom(doc, "n1", newRuntimeState("f", "n1"), effects);
  assert.equal(outcome.status, "completed");
  assert.deepEqual(sent, [{ kind: "text", payload: "Тавтай морил" }]);
});

test("message node with quickReplies uses sendQuickReplies", async () => {
  const { runFlowFrom, newRuntimeState } = await loadEngine();
  const { sent, effects } = recorder();
  const doc: FlowDoc = {
    id: "f",
    name: "n",
    enabled: true,
    nodes: [
      {
        id: "n1",
        position: { x: 0, y: 0 },
        data: { kind: "message", text: "Сонгоно уу", quickReplies: ["Тийм", "Үгүй"] },
      },
    ],
    edges: [],
  };
  await runFlowFrom(doc, "n1", newRuntimeState("f", "n1"), effects);
  assert.equal(sent[0].kind, "quick");
  assert.equal(sent[0].payload, "Сонгоно уу|Тийм,Үгүй");
});

/* ---- condition branching ---- */
test("condition node branches yes/no on tags", async () => {
  const { runFlowFrom, newRuntimeState } = await loadEngine();
  const doc: FlowDoc = {
    id: "f",
    name: "n",
    enabled: true,
    nodes: [
      { id: "c1", position: { x: 0, y: 0 }, data: { kind: "condition", logic: "and", rules: [{ operator: "has_tag", field: "vip" }] } },
      { id: "yes", position: { x: 0, y: 0 }, data: { kind: "message", text: "VIP" } },
      { id: "no", position: { x: 0, y: 0 }, data: { kind: "message", text: "Энгийн" } },
    ],
    edges: [
      { id: "e1", source: "c1", target: "yes", branch: "yes" },
      { id: "e2", source: "c1", target: "no", branch: "no" },
    ],
  };

  const vip = newRuntimeState("f", "c1");
  vip.tags.push("vip");
  const { sent, effects } = recorder();
  await runFlowFrom(doc, "c1", vip, effects);
  assert.equal(sent.at(-1)?.payload, "VIP");

  const { sent: sent2, effects: eff2 } = recorder();
  await runFlowFrom(doc, "c1", newRuntimeState("f", "c1"), eff2);
  assert.equal(sent2.at(-1)?.payload, "Энгийн");
});

/* ---- actions ---- */
test("action node adds tags, sets fields, notifies owner, captures lead", async () => {
  const { runFlowFrom, newRuntimeState } = await loadEngine();
  const { sent, effects } = recorder();
  const doc: FlowDoc = {
    id: "f",
    name: "n",
    enabled: true,
    nodes: [
      {
        id: "a1",
        position: { x: 0, y: 0 },
        data: {
          kind: "action",
          actions: [
            { type: "add_tag", tag: "interested" },
            { type: "set_field", fieldKey: "source", fieldValue: "messenger" },
            { type: "notify_owner", ownerMessage: "Шинэ хэрэглэгч" },
            { type: "capture_lead" },
          ],
        },
      },
    ],
    edges: [],
  };
  const st = newRuntimeState("f", "a1");
  await runFlowFrom(doc, "a1", st, effects);
  assert.ok(st.tags.includes("interested"));
  assert.equal(st.fields.source, "messenger");
  assert.ok(sent.some((s) => s.kind === "owner" && s.payload === "Шинэ хэрэглэгч"));
  assert.ok(sent.some((s) => s.kind === "lead"));
});

/* ---- user_input pause + resume ---- */
test("user_input pauses, then resume stores the answer and continues", async () => {
  const { runFlowFrom, resumeFlowWithInput, newRuntimeState } = await loadEngine();
  const { sent, effects } = recorder();
  const doc: FlowDoc = {
    id: "f",
    name: "n",
    enabled: true,
    nodes: [
      { id: "q1", position: { x: 0, y: 0 }, data: { kind: "user_input", prompt: "Утасны дугаараа?", saveToFieldKey: "phone", validationType: "phone" } },
      { id: "done", position: { x: 0, y: 0 }, data: { kind: "message", text: "Баярлалаа {{field.phone}}" } },
    ],
    edges: [{ id: "e1", source: "q1", target: "done" }],
  };

  const st = newRuntimeState("f", "q1");
  const paused = await runFlowFrom(doc, "q1", st, effects);
  assert.equal(paused.status, "waiting_input");
  assert.equal(sent[0].payload, "Утасны дугаараа?");

  // bad input → re-prompts, stays waiting
  const bad = await resumeFlowWithInput(doc, st, "сайн уу", effects);
  assert.equal(bad.status, "waiting_input");

  // good input → stores + continues + interpolates
  const good = await resumeFlowWithInput(doc, st, "99112233", effects);
  assert.equal(good.status, "completed");
  assert.equal(st.fields.phone, "99112233");
  assert.equal(sent.at(-1)?.payload, "Баярлалаа 99112233");
});

/* ---- ai_step handoff ---- */
test("ai_step node hands off to AI with optional override", async () => {
  const { runFlowFrom, newRuntimeState } = await loadEngine();
  const { effects } = recorder();
  const doc: FlowDoc = {
    id: "f",
    name: "n",
    enabled: true,
    nodes: [{ id: "ai", position: { x: 0, y: 0 }, data: { kind: "ai_step", systemPromptOverride: "Be concise" } }],
    edges: [],
  };
  const outcome = await runFlowFrom(doc, "ai", newRuntimeState("f", "ai"), effects);
  assert.equal(outcome.status, "handoff_to_ai");
  if (outcome.status === "handoff_to_ai") {
    assert.equal(outcome.systemPromptOverride, "Be concise");
  }
});

/* ---- validation + interpolation units ---- */
test("validateInput phone/email/number", async () => {
  const { validateInput } = await loadEngine();
  assert.equal(validateInput("99112233", "phone"), true);
  assert.equal(validateInput("abc", "phone"), false);
  assert.equal(validateInput("a@b.co", "email"), true);
  assert.equal(validateInput("nope", "email"), false);
  assert.equal(validateInput("42", "number"), true);
  assert.equal(validateInput("4.2", "number"), true);
  assert.equal(validateInput("x", "number"), false);
  assert.equal(validateInput("anything", "none"), true);
  assert.equal(validateInput("", "none"), false);
});

test("interpolate resolves {{field.x}} and blanks unknowns", async () => {
  const { interpolate, newRuntimeState } = await loadEngine();
  const st: FlowRuntimeState = newRuntimeState("f", "n1");
  st.fields.name = "Бат";
  assert.equal(interpolate("Сайн уу {{field.name}}!", st), "Сайн уу Бат!");
  assert.equal(interpolate("{{field.missing}}", st), "");
  assert.equal(interpolate("{{nonsense}}", st), "");
});

/* ---- safety: cycle guard ---- */
test("runFlowFrom does not loop forever on a cycle", async () => {
  const { runFlowFrom, newRuntimeState } = await loadEngine();
  const { effects } = recorder();
  const doc: FlowDoc = {
    id: "f",
    name: "n",
    enabled: true,
    nodes: [
      { id: "a", position: { x: 0, y: 0 }, data: { kind: "jump", targetNodeId: "b" } },
      { id: "b", position: { x: 0, y: 0 }, data: { kind: "jump", targetNodeId: "a" } },
    ],
    edges: [],
  };
  const outcome = await runFlowFrom(doc, "a", newRuntimeState("f", "a"), effects);
  assert.equal(outcome.status, "completed");
});
