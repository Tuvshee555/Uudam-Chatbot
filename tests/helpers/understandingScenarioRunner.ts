import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { conversationGateHarness, type FixtureTrip, type ModelOverride } from "./conversationGateHarness";
import { ARCHIVED, CATALOGUE, allowedAmounts, allowedDays, titleOf } from "./understandingCatalogue";
import { RE, type Before, type Expect, type FailureKind, type ReportRow, type Scenario, type Turn } from "./understandingScenarioTypes";

/**
 * Replays understanding scenarios through the real signed webhook (conversationGateHarness) and
 * judges each turn by assertable predicates on what the customer would see. See
 * tests/understanding-scenarios.test.ts for the modes and environment variables.
 */

export const DEFAULT_NOW = "2026-11-06T04:00:00Z";
const MIN = 60_000;
/** The booking website's weather report for one trip, naming the trip it was asked for. */
const weatherText = (source: string) => `🌍 Очих хотуудад одоогоор: ${source}: 14°C, багавтар үүлтэй.`;

export type RunMode = "assert" | "report" | "strict";
export type RunOptions = { mode: RunMode; reportPath?: string; only?: RegExp; dump?: boolean; open?: ReadonlySet<string> };

type Captured = { event: string; [key: string]: unknown };

const POLICY_CLAIM = new RegExp([
  "(?:Тийм|тийм)[^\\n]{0,90}(?:хямдрал|хөнгөлөлт|урамшуул|бартер|бонус|гэрээ)",
  "(?:тусгай\\s+)?хямдрал(?:тай)?\\s+(?:санал\\s+)?(?:болгодог|олгодог|үзүүлдэг|байна|бий)",
  "(?:хямдрал|хөнгөлөлт)[^\\n]{0,40}(?:олгоно|үзүүлнэ|болгоно|байдаг)",
  "бартер[^\\n]{0,40}(?:авдаг|хүлээн авна|хүлээн авдаг|боломжтой|болно)",
  "байгууллагын\\s+гэрээгээр[^\\n]{0,50}(?:боломжтой|төлж болно|болно)",
  "(?:урьдчилгаа|барьцаа)[^\\n]{0,30}\\d+\\s*%",
].join("|"), "iu");
// Only a denial or an admission of no data excuses a policy word; "ask the consultant" after a claim does not.
const POLICY_DISCLAIMER = /баталгаажаагүй|тодорхойгүй|мэдээлэл алга|мэдээлэл олдсонгүй|байхгүй|боломжгүй/i;

const norm = (value: string) => value.replace(/\s+/g, " ").trim();

function mentions(reply: string, id: string): boolean {
  const title = titleOf(id);
  return reply.includes(title) || (title.length > 30 && reply.includes(title.slice(0, 30)));
}

/** Dates in a reply as ISO strings in the year that puts them nearest to the mocked "now". */
function datesIn(reply: string, now: number): Array<{ token: string; iso: string; day: string }> {
  const found: Array<{ token: string; iso: string; day: string }> = [];
  const push = (token: string, month: number, dayOfMonth: number) => {
    if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return;
    const year = new Date(now).getUTCFullYear();
    let iso = new Date(Date.UTC(year, month - 1, dayOfMonth)).getTime();
    if (iso < now - 60 * 86_400_000) iso = new Date(Date.UTC(year + 1, month - 1, dayOfMonth)).getTime();
    found.push({ token, iso: new Date(iso).toISOString().slice(0, 10), day: `${month}/${dayOfMonth}` });
  };
  // A line restating the customer's own window ("3 сарын 10 – 3 сарын 16-ны хооронд") is not a departure.
  const body = reply.split("\n").filter((line) => !/хооронд/.test(line)).join("\n");
  for (const match of body.matchAll(/(?<![\d,.:])(\d{1,2})\/(\d{1,2})(?![\d,:])/g)) push(match[0], Number(match[1]), Number(match[2]));
  for (const match of body.matchAll(/(\d{1,2}) сарын (\d{1,2})(?![\d,])/g)) push(match[0], Number(match[1]), Number(match[2]));
  return found;
}

/** The customer's own dates and numbers: a reply may repeat them. */
function customerNumbers(text: string): { days: Set<string>; amounts: Set<number> } {
  const days = new Set<string>();
  for (const match of text.matchAll(/(\d{1,2})[./](\d{1,2})/g)) days.add(`${Number(match[1])}/${Number(match[2])}`);
  for (const match of text.matchAll(/(\d{1,2})\s*(?:-?р\s*)?сарын\s*(\d{1,2})/g)) days.add(`${Number(match[1])}/${Number(match[2])}`);
  const amounts = new Set<number>();
  for (const match of text.matchAll(/\d[\d.,\s]{3,}\d/g)) {
    const digits = Number(match[0].replace(/[^\d]/g, ""));
    if (digits >= 10_000) amounts.add(digits);
  }
  return { days, amounts };
}

const TRIP_CONTENT = /Гарах өдрүүд|сонголт бий|Аяллууд:|Манай аяллууд|гарах аяллууд|Өөр \d+ (?:сонголт|аялал)|Тэр хугацаанд гарах аялал/i;

function tripContentIn(reply: string): string | null {
  for (const entry of CATALOGUE) if (mentions(reply, entry.id)) return `names trip ${entry.id}`;
  if (/₮/.test(reply)) return "quotes a fare";
  const heading = TRIP_CONTENT.exec(reply);
  return heading ? `lists trips ("${heading[0]}")` : null;
}

export type TurnOutcome = {
  reply: string; sends: number; route: string | null; silentReason: string | null; leadKind: string | null; modelCalls: number;
  answerModelCalls: number; selection: string | null; leadsForSender: Array<{ kind: string; context: string }>; newLeads: number;
};

/** The predicates that judge one turn. Returns "<kind>: <detail>" strings; empty means pass. */
export function judgeTurn(args: { outcome: TurnOutcome; text: string; expect: Expect; owned: boolean; unavailable: boolean; now: number }): string[] {
  const { outcome, text, expect, owned, now } = args;
  const failures: string[] = [];
  const fail = (kind: FailureKind, detail: string) => failures.push(`${kind}: ${detail}`);
  const reply = outcome.reply;
  const sent = outcome.sends > 0;

  // ---- always on: staff own the conversation
  if (owned) {
    if (sent) fail("human-violation", `the bot sent a message while staff own the conversation: ${norm(reply).slice(0, 80)}`);
    if (outcome.modelCalls + outcome.answerModelCalls > 0) fail("human-violation", `a model call was spent while staff own the conversation (${outcome.modelCalls}+${outcome.answerModelCalls})`);
  }

  // ---- always on: every price, date and policy claim must be backed by the catalogue
  if (sent) {
    const mine = customerNumbers(text);
    const amounts = allowedAmounts();
    for (const match of reply.matchAll(/(\d{1,3}(?:,\d{3})+)₮/g)) {
      const amount = Number(match[1].replace(/,/g, ""));
      if (!amounts.has(amount) && !mine.amounts.has(amount)) fail("unsupported-claim", `amount ${match[0]} is not a catalogue fare or a sum of fares`);
    }
    const days = allowedDays();
    for (const date of datesIn(reply, now)) {
      if (!days.has(date.day) && !mine.days.has(date.day) && !["2/6", "2/7", "2/8", "2/9"].includes(date.day)) fail("unsupported-claim", `date ${date.token} is not a catalogue departure`);
    }
    const claim = POLICY_CLAIM.exec(reply);
    if (claim && !POLICY_DISCLAIMER.test(reply)) fail("unsupported-claim", `a commercial policy the catalogue and settings do not hold: "${norm(claim[0]).slice(0, 90)}"`);
    if (/undefined|\bnull\b|NaN|Invalid Date/.test(reply)) fail("wrong-topic", "malformed reply (undefined/null/NaN)");
  }

  // ---- silence and answers
  const requiredContent = (expect.mustMatch?.length ?? 0) + (expect.anyOf?.length ?? 0) > 0;
  const needsReply = !owned && (expect.mustAnswer || (requiredContent && !expect.allowSilence && !expect.silent));
  if (needsReply && !sent) fail("silence-on-answerable", `nothing was sent (silent reason: ${outcome.silentReason ?? "none"}, route: ${outcome.route ?? "none"})`);
  if (expect.silent && sent && !owned) fail("wrong-topic", `a reply was sent where silence is required: ${norm(reply).slice(0, 100)}`);
  if (expect.replyCount !== undefined && outcome.sends !== expect.replyCount) fail("reply-count", `${outcome.sends} messages sent, expected ${expect.replyCount}`);

  if (sent) {
    for (const re of expect.mustMatch ?? []) if (!re.test(reply)) fail("missing-answer", `reply does not match ${re}: ${norm(reply).slice(0, 100)}`);
    if (expect.anyOf?.length && !expect.anyOf.some((re) => re.test(reply))) fail("missing-answer", `reply matches none of ${expect.anyOf.map(String).join(" | ")}: ${norm(reply).slice(0, 100)}`);
    for (const re of expect.ifReplyMustMatch ?? []) if (!re.test(reply)) fail("missing-answer", `reply does not match ${re}: ${norm(reply).slice(0, 100)}`);
    for (const re of expect.mustNotMatch ?? []) if (re.test(reply)) fail("wrong-topic", `reply matches ${re}: ${norm(reply).slice(0, 100)}`);
    for (const re of expect.mustNotClaim ?? []) if (re.test(reply)) fail("unsupported-claim", `reply matches ${re}: ${norm(reply).slice(0, 100)}`);
    for (const id of expect.mustNotMentionTripIds ?? []) if (mentions(reply, id)) fail("wrong-trip", `reply names ${id} (${titleOf(id)})`);
    for (const id of expect.mustMentionTripIds ?? []) if (!mentions(reply, id)) fail("missing-answer", `reply does not name ${id} (${titleOf(id)})`);
    if (expect.noTripContent) { const content = tripContentIn(reply); if (content) fail("wrong-topic", `trip content in a reply to a non-trip need: ${content}`); }
    // A list that ends "which one?" is an answer; a reply that is only the question is not.
    if (expect.noClarification && RE.clarify.test(reply) && !tripContentIn(reply)) fail("unnecessary-clarification", `a counter-question where the data answers: ${norm(reply).slice(0, 100)}`);
    if (expect.noOutage && RE.outage.test(reply)) fail("outage-text", "the system-is-down notice for a need that does not need the model");
    if (expect.datesWithin) {
      const [from, to] = expect.datesWithin;
      for (const date of datesIn(reply, now)) if (date.iso < from || date.iso > to) fail("wrong-date", `date ${date.token} (${date.iso}) is outside ${from}..${to}`);
    }
  }

  // ---- bookkeeping
  if (expect.lead) {
    const match = outcome.leadsForSender.find((lead) => (!expect.lead!.kind || lead.kind === expect.lead!.kind) && (!expect.lead!.contextMatches || expect.lead!.contextMatches.test(lead.context)));
    if (!match) fail("lead", `staff have no ${expect.lead.kind ?? "any"} lead for this customer (${outcome.leadsForSender.map((lead) => lead.kind).join(",") || "none"})`);
  }
  if (expect.leadIfSilent && !sent && !owned && outcome.leadsForSender.length === 0) fail("lead", "silent, and staff have no lead for this customer (the no-data rule needs both)");
  if (expect.noNewLead && outcome.newLeads > 0) fail("lead", `${outcome.newLeads} lead(s) written for a message that needs none`);
  if (expect.selectionAfter !== undefined && outcome.selection !== expect.selectionAfter) fail("selection", `selection is ${outcome.selection ?? "none"}, expected ${expect.selectionAfter ?? "none"}`);
  if (expect.noModelCalls && outcome.modelCalls + outcome.answerModelCalls > 0) fail("model-calls", `${outcome.modelCalls}+${outcome.answerModelCalls} model calls, expected none`);
  if (expect.maxModelCalls !== undefined && outcome.modelCalls + outcome.answerModelCalls > expect.maxModelCalls) fail("model-calls", `${outcome.modelCalls}+${outcome.answerModelCalls} model calls, expected at most ${expect.maxModelCalls}`);
  return failures;
}

const mergeExpect = (own: Expect | undefined, all: Expect | undefined): Expect => {
  if (!all) return own ?? {};
  const merged: Record<string, unknown> = { ...all, ...own };
  for (const key of ["mustMatch", "ifReplyMustMatch", "mustNotMatch", "mustNotClaim", "mustNotMentionTripIds", "mustMentionTripIds"] as const) {
    const joined = [...(all[key] ?? []), ...(own?.[key] ?? [])];
    if (joined.length) merged[key] = joined;
  }
  return merged as Expect;
};

export function loadOpenScenarios(): Set<string> {
  const file = join(process.cwd(), "tests", "fixtures", "understanding-scenarios-open.json");
  if (!existsSync(file)) return new Set();
  try { return new Set(JSON.parse(readFileSync(file, "utf8")) as string[]); } catch { return new Set(); }
}

/** Runs every scenario in one harness (one clock, one catalogue). Returns all report rows. */
export async function runScenarios(context: TestContext, scenarios: Scenario[], options: RunOptions): Promise<ReportRow[]> {
  const harness = await conversationGateHarness(context);
  const { setTripSelection } = await import("../../src/lib/tripSelectionState");
  const { Pool } = await import("pg");
  context.mock.timers.setTime(Date.parse(DEFAULT_NOW));
  harness.catalog(CATALOGUE);

  // Archived trips are served by a separate query the stock harness answers with nothing.
  const innerQuery = Pool.prototype.query;
  Pool.prototype.query = (async function archivedAware(this: unknown, sql: string, params?: unknown[]) {
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(String(sql)) && params?.[1] === "archived") return { rows: ARCHIVED, rowCount: ARCHIVED.length };
    return (innerQuery as (...args: unknown[]) => unknown).call(this, sql, params);
  }) as unknown as typeof Pool.prototype.query;

  // The booking website's weather API: reachable (a fixed report naming the asked trip) or down.
  const innerFetch = globalThis.fetch;
  let weather: "ok" | "down" = "ok";
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/weather")) {
      if (weather === "down") throw new Error("weather api down");
      const source = new URL(url).searchParams.get("source") || "unknown";
      return new Response(JSON.stringify({ text: weatherText(source), tripSlug: `slug-${source}` }), { status: 200 });
    }
    return innerFetch(input as never, init);
  }) as typeof fetch;

  // Structured log lines carry the route of each turn (webhook.inbound_outcome).
  const captured: Captured[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const hook = (inner: (...args: unknown[]) => void) => (...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.startsWith('{"ts"')) { try { captured.push(JSON.parse(first) as Captured); return; } catch { /* print it */ } }
    inner(...args);
  };
  console.log = hook(original.log); console.info = hook(original.info); console.warn = hook(original.warn); console.error = hook(original.error);
  const restore = () => {
    Object.assign(console, original);
    Pool.prototype.query = innerQuery;
    globalThis.fetch = innerFetch;
  };

  const rows: ReportRow[] = [];
  try {
    for (const scenario of scenarios) {
      if (options.only && !options.only.test(scenario.id)) continue;
      const isOpen = options.mode === "assert" && options.open?.has(scenario.id);
      const body = async () => {
        const scenarioRows = await runScenario(scenario);
        rows.push(...scenarioRows);
        if (options.mode === "report") return;
        const failed = scenarioRows.filter((row) => row.verdict === "fail");
        if (failed.length) {
          const detail = failed.map((row) => `  turn ${row.turn} "${row.input.slice(0, 80)}"\n    reply: ${norm(row.reply).slice(0, 160) || "(silent)"}\n    ${row.failedPredicates.join("\n    ")}`).join("\n");
          throw new Error(`${scenario.id} (${scenario.title}) failed ${failed.length} of ${scenarioRows.filter((row) => !row.setup).length} judged turns:\n${detail}`);
        }
      };
      await context.test(scenario.id, isOpen ? { todo: "open at the baseline run; see tests/fixtures/understanding-scenarios-open.json" } : {}, body);
    }
  } finally {
    restore();
    try { await harness.close(); } catch (error) { if (options.mode !== "report") throw error; console.error(`[scenario suite] harness close: ${(error as Error).message}`); }
  }
  if (options.reportPath) writeFileSync(options.reportPath, JSON.stringify(rows, null, 2));
  return rows;

  async function runScenario(scenario: Scenario): Promise<ReportRow[]> {
    const sender = `scn-${scenario.id}`;
    const platform = scenario.platform ?? "facebook";
    const out: ReportRow[] = [];
    const now = Date.parse(scenario.at ?? DEFAULT_NOW);
    context.mock.timers.setTime(now);
    weather = scenario.weather ?? "ok";
    const midsBefore = harness.botMids().length;
    let owned = false;
    let lastCustomerText = "Сайн байна уу";
    const applyBefore = async (before: Before | undefined) => {
      if (!before) return;
      if (before.weather) weather = before.weather;
      if (before.selection !== undefined) {
        await setTripSelection(sender, before.selection ? { tripId: before.selection.tripId, date: before.selection.date ?? null, hotel: null, package: null, passengers: [] } : null);
      }
      if (before.resume) { harness.resume(sender); owned = false; }
      if (before.pause) { harness.pause(sender); owned = true; }
      if (before.consultantAgoMs !== undefined) {
        const agoMs = before.consultantAgoMs;
        harness.thread(sender, { messages: [
          { from: "customer", text: lastCustomerText, agoMs: agoMs + 12 * MIN },
          ...harness.botMids().slice(midsBefore).map((id, index) => ({ from: "page" as const, id, source: "web" as const, agoMs: agoMs + 10 * MIN - index * 1000 })),
          { from: "page", source: "mobile", text: "Сайн байна уу, би аяллын зөвлөх", agoMs },
        ] });
        // A consultant newer than the takeover window owns the chat; an old one is only history.
        if (agoMs < 3 * 86_400_000) owned = true;
      }
    };
    if (scenario.staffHistoryAgoMs !== undefined) await applyBefore({ consultantAgoMs: scenario.staffHistoryAgoMs });
    await applyBefore(scenario.before);
    for (const [index, turn] of scenario.turns.entries()) {
      await applyBefore(turn.before);
      const model = (turn.model ?? scenario.model ?? { intent: "other", topics: [], certainty: "none" }) as ModelOverride;
      const mark = captured.length;
      const result = await harness.turn(sender, turn.text, model, undefined, { platform });
      lastCustomerText = turn.text;
      const events = captured.slice(mark);
      const outcomeEvent = [...events].reverse().find((event) => event.event === "webhook.inbound_outcome");
      const outcome: TurnOutcome = {
        reply: result.sends.map((send) => send.text).join("\n⟂\n"), sends: result.sends.length,
        route: (outcomeEvent?.route as string | null | undefined) ?? null, silentReason: (outcomeEvent?.silent as string | null | undefined) ?? null,
        leadKind: result.leads.length ? result.leads.map((lead) => lead.kind).join(",") : null,
        modelCalls: result.modelCalls, answerModelCalls: result.answerModelCalls, selection: result.selection?.tripId ?? null,
        leadsForSender: harness.leads.filter((lead) => lead.sender_id === sender).map((lead) => ({ kind: lead.kind, context: lead.context })),
        newLeads: result.leads.length,
      };
      const expect = turn.setup ? {} : mergeExpect(turn.expect, scenario.expectAll);
      const failedPredicates = turn.setup ? [] : judgeTurn({ outcome, text: turn.text, expect, owned, unavailable: Boolean((model as { unavailable?: boolean }).unavailable), now });
      const row: ReportRow = {
        id: scenario.id, historicalCase: scenario.historicalCase ?? null, tags: [...new Set([...scenario.tags, ...(turn.tags ?? [])])], turn: index + 1,
        input: turn.text, reply: outcome.reply, route: outcome.route, leadKind: outcome.leadKind, silent: outcome.sends === 0,
        modelCalls: outcome.modelCalls + outcome.answerModelCalls, verdict: failedPredicates.length ? "fail" : "pass", failedPredicates,
        setup: Boolean(turn.setup), replyCount: outcome.sends, answerModelCalls: outcome.answerModelCalls,
        unavailable: Boolean((model as { unavailable?: boolean }).unavailable), staffOwned: owned, selection: outcome.selection,
      };
      out.push(row);
      if (options.dump) original.log(`[${row.verdict.toUpperCase()}] ${row.id}#${row.turn} "${row.input.slice(0, 90)}"\n    route=${row.route} silent=${row.silent} lead=${row.leadKind} models=${outcome.modelCalls}/${outcome.answerModelCalls} sel=${row.selection}\n    reply: ${norm(row.reply).slice(0, 260) || "(silent)"}${failedPredicates.length ? `\n    ${failedPredicates.join("\n    ")}` : ""}`);
    }
    return out;
  }
}

export type { FixtureTrip, Turn };
