/**
 * Flow engine — a node-graph conversation interpreter, adapted from SelloAI's
 * flow-runner for Uudam's single-tenant, Redis-backed, travel-focused model.
 *
 * A flow is a directed graph of nodes connected by edges. The bot walks the
 * graph for a given sender, sending messages, branching on conditions, running
 * actions (tags / fields / notify owner / capture lead), pausing on user_input
 * until the next message arrives, and resuming.
 *
 * Storage:
 *   - Flow definitions live in bot_settings.extra.flowDocs (array of FlowDoc).
 *   - Per-sender runtime state (which node we're on, collected fields, tags)
 *     lives in Redis keyed by sender, with an in-memory fallback.
 *
 * Backward compatibility:
 *   - The old flat keyword rules (bot_settings.extra.flows: FlowRule[]) and
 *     matchFlow() still work, untouched. New graph flows are additive.
 */

import { withRedis } from "./redisState";

/* ----------------------------------------------------------------
   Legacy flat-rule flows (kept for backward compatibility)
   ---------------------------------------------------------------- */
export type FlowRule = {
  id: string;
  keywords: string; // comma-separated trigger words
  reply: string; // bot reply text
  buttons: string[]; // quick-reply button labels
};

/**
 * Checks if the user's message matches any legacy flat flow rule.
 * Returns the first matching rule, or null if none match.
 * Matching is substring-based (case-insensitive).
 */
export function matchFlow(userText: string, rules: FlowRule[]): FlowRule | null {
  const norm = userText.toLowerCase();
  for (const rule of rules) {
    const keywords = rule.keywords
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (keywords.some((k) => k.length > 0 && norm.includes(k))) {
      return rule;
    }
  }
  return null;
}

/* ----------------------------------------------------------------
   Node-graph types (adapted from SelloAI flow-types.ts)
   ---------------------------------------------------------------- */
export type NodeKind =
  | "trigger"
  | "message"
  | "condition"
  | "action"
  | "user_input"
  | "ai_step"
  | "jump";

export type MatchType = "contains" | "exact" | "starts_with" | "ends_with";

export type TriggerNodeData = {
  kind: "trigger";
  triggerType: "keyword" | "new_subscriber" | "manual";
  keywords?: string[];
  matchType?: MatchType;
};

export type MessageNodeData = {
  kind: "message";
  text: string;
  imageUrls?: string[]; // sent as Messenger image attachments
  quickReplies?: string[]; // tappable chips
};

export type ConditionOperator =
  | "has_tag"
  | "not_has_tag"
  | "field_equals"
  | "field_contains"
  | "field_exists"
  | "field_missing";

export type ConditionRule = {
  operator: ConditionOperator;
  field?: string; // tag name or field key
  value?: string;
};

export type ConditionNodeData = {
  kind: "condition";
  logic: "and" | "or";
  rules: ConditionRule[];
};

export type ActionType =
  | "add_tag"
  | "remove_tag"
  | "set_field"
  | "notify_owner"
  | "capture_lead";

export type FlowAction = {
  type: ActionType;
  tag?: string;
  fieldKey?: string;
  fieldValue?: string;
  ownerMessage?: string;
};

export type ActionNodeData = {
  kind: "action";
  actions: FlowAction[];
};

export type UserInputNodeData = {
  kind: "user_input";
  prompt: string; // question to ask
  saveToFieldKey: string; // where to store the answer
  validationType?: "none" | "phone" | "email" | "number";
  invalidMessage?: string;
};

export type AiStepNodeData = {
  kind: "ai_step";
  // When reached, hand control back to the normal AI pipeline once.
  // Optional system prompt override is appended to the base prompt.
  systemPromptOverride?: string;
};

export type JumpNodeData = {
  kind: "jump";
  targetNodeId?: string;
};

export type AnyNodeData =
  | TriggerNodeData
  | MessageNodeData
  | ConditionNodeData
  | ActionNodeData
  | UserInputNodeData
  | AiStepNodeData
  | JumpNodeData;

export type FlowNode = {
  id: string;
  position: { x: number; y: number };
  data: AnyNodeData;
};

export type FlowBranch = "yes" | "no";

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null; // "yes" / "no" for condition branches
  branch?: FlowBranch;
};

export type FlowDoc = {
  id: string;
  name: string;
  enabled: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
};

/* ----------------------------------------------------------------
   Per-sender runtime state (Redis-backed, in-memory fallback)
   ---------------------------------------------------------------- */
export type FlowRuntimeState = {
  flowId: string;
  currentNodeId: string; // node we're paused at (a user_input node)
  fields: Record<string, string>; // collected custom fields
  tags: string[]; // contact tags
  startedAt: number;
};

const TTL_MS = 60 * 60 * 1000; // 1 hour
const REDIS_TTL_SEC = 60 * 60;
const memStore = new Map<string, FlowRuntimeState>();

function stateKey(senderId: string, platform: string) {
  return `flow_state:${platform}:${senderId}`;
}

export async function getFlowState(
  senderId: string,
  platform: string,
): Promise<FlowRuntimeState | null> {
  const redisResult = await withRedis("flow.get_state", async (r) => {
    const raw = await r.get(stateKey(senderId, platform));
    return raw ? (JSON.parse(raw) as FlowRuntimeState) : null;
  });
  if (redisResult !== null) return redisResult;

  const mem = memStore.get(stateKey(senderId, platform));
  if (!mem) return null;
  if (Date.now() - mem.startedAt > TTL_MS) {
    memStore.delete(stateKey(senderId, platform));
    return null;
  }
  return mem;
}

export async function setFlowState(
  senderId: string,
  platform: string,
  state: FlowRuntimeState,
): Promise<void> {
  const applied = await withRedis("flow.set_state", async (r) => {
    await r.set(stateKey(senderId, platform), JSON.stringify(state), "EX", REDIS_TTL_SEC);
    return true;
  });
  if (!applied) memStore.set(stateKey(senderId, platform), state);
}

export async function clearFlowState(senderId: string, platform: string): Promise<void> {
  await withRedis("flow.clear_state", async (r) => {
    await r.del(stateKey(senderId, platform));
  });
  memStore.delete(stateKey(senderId, platform));
}

/* ----------------------------------------------------------------
   Graph helpers
   ---------------------------------------------------------------- */
function getNode(doc: FlowDoc, id: string | null): FlowNode | null {
  if (!id) return null;
  return doc.nodes.find((n) => n.id === id) || null;
}

function getDefaultNext(doc: FlowDoc, nodeId: string): string | null {
  const edge = doc.edges.find(
    (e) =>
      e.source === nodeId &&
      !e.branch &&
      e.sourceHandle !== "yes" &&
      e.sourceHandle !== "no",
  );
  return edge?.target || null;
}

function getBranchNext(doc: FlowDoc, nodeId: string, branch: FlowBranch): string | null {
  const edge = doc.edges.find(
    (e) => e.source === nodeId && (e.branch === branch || e.sourceHandle === branch),
  );
  return edge?.target || getDefaultNext(doc, nodeId);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/* ----------------------------------------------------------------
   Trigger matching
   ---------------------------------------------------------------- */
export function matchKeyword(text: string, keywords: string[], matchType: MatchType): boolean {
  const t = normalize(text);
  return keywords.some((kw) => {
    const k = normalize(kw);
    if (!k) return false;
    switch (matchType) {
      case "exact":
        return t === k;
      case "starts_with":
        return t.startsWith(k);
      case "ends_with":
        return t.endsWith(k);
      case "contains":
      default:
        return t.includes(k);
    }
  });
}

/**
 * Finds the first enabled flow whose trigger node matches this incoming text.
 * Returns the flow and the node to start execution from (the node after the
 * trigger), or null if nothing matches.
 */
export function findTriggeredFlow(
  text: string,
  docs: FlowDoc[],
): { doc: FlowDoc; startNodeId: string } | null {
  for (const doc of docs) {
    if (!doc.enabled) continue;
    const trigger = doc.nodes.find((n) => n.data.kind === "trigger");
    if (!trigger) continue;
    const data = trigger.data as TriggerNodeData;
    if (data.triggerType !== "keyword") continue;
    const keywords = data.keywords || [];
    if (!keywords.length) continue;
    if (matchKeyword(text, keywords, data.matchType || "contains")) {
      const startNodeId = getDefaultNext(doc, trigger.id);
      if (startNodeId) return { doc, startNodeId };
    }
  }
  return null;
}

/* ----------------------------------------------------------------
   Condition evaluation
   ---------------------------------------------------------------- */
function evaluateRule(rule: ConditionRule, state: FlowRuntimeState): boolean {
  switch (rule.operator) {
    case "has_tag":
      return state.tags.includes(rule.field || "");
    case "not_has_tag":
      return !state.tags.includes(rule.field || "");
    case "field_equals":
      return normalize(state.fields[rule.field || ""] || "") === normalize(rule.value || "");
    case "field_contains":
      return normalize(state.fields[rule.field || ""] || "").includes(normalize(rule.value || ""));
    case "field_exists":
      return Boolean(state.fields[rule.field || ""]);
    case "field_missing":
      return !state.fields[rule.field || ""];
    default:
      return false;
  }
}

function evaluateCondition(data: ConditionNodeData, state: FlowRuntimeState): boolean {
  const outcomes = data.rules.map((r) => evaluateRule(r, state));
  return data.logic === "or" ? outcomes.some(Boolean) : outcomes.every(Boolean);
}

/* ----------------------------------------------------------------
   Variable interpolation — {{field.xyz}}
   ---------------------------------------------------------------- */
export function interpolate(template: string, state: FlowRuntimeState): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const trimmed = expr.trim();
    if (trimmed.startsWith("field.")) {
      return state.fields[trimmed.slice("field.".length)] || "";
    }
    return "";
  });
}

/* ----------------------------------------------------------------
   Validation for user_input nodes
   ---------------------------------------------------------------- */
export function validateInput(
  value: string,
  type: UserInputNodeData["validationType"],
): boolean {
  const v = value.trim();
  if (!v) return false;
  switch (type) {
    case "phone":
      return /[0-9]{6,}/.test(v.replace(/[\s\-()]/g, ""));
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    case "number":
      return /^-?\d+(\.\d+)?$/.test(v);
    case "none":
    default:
      return true;
  }
}

/* ----------------------------------------------------------------
   Side-effect callbacks — the host (webhook) provides these so the
   engine stays free of platform/DB coupling.
   ---------------------------------------------------------------- */
export type FlowEffects = {
  sendText: (text: string) => Promise<void>;
  sendImage?: (url: string) => Promise<void>;
  sendQuickReplies?: (text: string, labels: string[]) => Promise<void>;
  notifyOwner?: (message: string) => Promise<void>;
  captureLead?: (state: FlowRuntimeState) => Promise<void>;
};

export type RunOutcome =
  | { status: "completed" }
  | { status: "waiting_input"; nodeId: string } // paused on a user_input node
  | { status: "handoff_to_ai"; systemPromptOverride?: string } // ai_step reached
  | { status: "skipped" };

/* ----------------------------------------------------------------
   Core interpreter
   ---------------------------------------------------------------- */
const MAX_STEPS = 100;

/**
 * Walk the flow graph from `startNodeId`, applying side effects via `effects`.
 * `state` is mutated in place (fields/tags accumulate); the caller persists it.
 * Returns where execution ended.
 */
export async function runFlowFrom(
  doc: FlowDoc,
  startNodeId: string,
  state: FlowRuntimeState,
  effects: FlowEffects,
): Promise<RunOutcome> {
  let currentNodeId: string | null = startNodeId;
  const visited = new Set<string>();
  let steps = 0;

  while (currentNodeId) {
    if (++steps > MAX_STEPS) return { status: "completed" };
    if (visited.has(currentNodeId)) break;
    visited.add(currentNodeId);

    const node = getNode(doc, currentNodeId);
    if (!node) break;
    state.currentNodeId = node.id;

    if (node.data.kind === "message") {
      const data = node.data;
      const text = interpolate(data.text || "", state);
      if (data.quickReplies && data.quickReplies.length && effects.sendQuickReplies) {
        await effects.sendQuickReplies(text || "⬇️", data.quickReplies);
      } else if (text) {
        await effects.sendText(text);
      }
      if (data.imageUrls && effects.sendImage) {
        for (const url of data.imageUrls) {
          try {
            await effects.sendImage(url);
          } catch {
            // one bad image shouldn't kill the flow
          }
        }
      }
      currentNodeId = getDefaultNext(doc, node.id);
      continue;
    }

    if (node.data.kind === "condition") {
      const passed = evaluateCondition(node.data, state);
      currentNodeId = getBranchNext(doc, node.id, passed ? "yes" : "no");
      continue;
    }

    if (node.data.kind === "action") {
      for (const action of node.data.actions) {
        if (action.type === "add_tag" && action.tag) {
          if (!state.tags.includes(action.tag)) state.tags.push(action.tag);
        } else if (action.type === "remove_tag" && action.tag) {
          state.tags = state.tags.filter((t) => t !== action.tag);
        } else if (action.type === "set_field" && action.fieldKey) {
          state.fields[action.fieldKey] = interpolate(action.fieldValue || "", state);
        } else if (action.type === "notify_owner" && action.ownerMessage && effects.notifyOwner) {
          await effects.notifyOwner(interpolate(action.ownerMessage, state));
        } else if (action.type === "capture_lead" && effects.captureLead) {
          await effects.captureLead(state);
        }
      }
      currentNodeId = getDefaultNext(doc, node.id);
      continue;
    }

    if (node.data.kind === "user_input") {
      // Send the prompt and pause — the next inbound message resumes here.
      const prompt = interpolate(node.data.prompt || "", state);
      if (prompt) await effects.sendText(prompt);
      state.currentNodeId = node.id;
      return { status: "waiting_input", nodeId: node.id };
    }

    if (node.data.kind === "ai_step") {
      return {
        status: "handoff_to_ai",
        systemPromptOverride: node.data.systemPromptOverride,
      };
    }

    if (node.data.kind === "jump") {
      currentNodeId = node.data.targetNodeId || getDefaultNext(doc, node.id);
      continue;
    }

    if (node.data.kind === "trigger") {
      currentNodeId = getDefaultNext(doc, node.id);
      continue;
    }

    // Unknown node kind — stop safely.
    break;
  }

  return { status: "completed" };
}

/**
 * Resume a flow that was paused on a user_input node, given the user's answer.
 * Validates the answer, stores it to the node's field, then continues from the
 * next node. Returns the outcome (may pause again or complete).
 */
export async function resumeFlowWithInput(
  doc: FlowDoc,
  state: FlowRuntimeState,
  userText: string,
  effects: FlowEffects,
): Promise<RunOutcome> {
  const node = getNode(doc, state.currentNodeId);
  if (!node || node.data.kind !== "user_input") {
    return { status: "skipped" };
  }
  const data = node.data;

  if (!validateInput(userText, data.validationType)) {
    const msg = data.invalidMessage || "Уучлаарай, дахин оролдоно уу.";
    await effects.sendText(msg);
    return { status: "waiting_input", nodeId: node.id };
  }

  state.fields[data.saveToFieldKey] = userText.trim();
  const next = getDefaultNext(doc, node.id);
  if (!next) return { status: "completed" };
  return runFlowFrom(doc, next, state, effects);
}

export function newRuntimeState(flowId: string, startNodeId: string): FlowRuntimeState {
  return {
    flowId,
    currentNodeId: startNodeId,
    fields: {},
    tags: [],
    startedAt: Date.now(),
  };
}
