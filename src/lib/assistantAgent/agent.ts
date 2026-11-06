/**
 * The admin assistant's agent: one OpenAI function-calling loop per typed instruction.
 *
 * The model reads with tools (search_trips, get_trip, resolve_link, read_web_page,
 * host_image) and ends the turn with one terminal tool: propose_changes, ask_user, reply or
 * read_trip_source. Code decides what may come out of it (actions.ts): only trips this turn
 * really looked at, only the trip a pasted link names, never a partner trip's prices or
 * dates, only photos we host, every action version-stamped. Nothing here writes; a proposal
 * is reviewed and saved by the admin like every other.
 *
 * Limits: at most 6 model rounds, about 60 s in all (each call gets what is left, at most
 * 30 s), the day's AI budget checked first. A timeout or an unreachable model ends the turn
 * with a plain Mongolian note; nothing is half-done.
 */
import { logInfo } from "../observability";
import { amountsInText, type AssistantAskPayload } from "../assistantBrain";
import { buildAgentProposal } from "./actions";
import { defaultAgentDeps } from "./deps";
import { withoutUrls } from "./links";
import { AgentModelError, type AgentModelFailure } from "./openaiTools";
import { buildSystemPrompt, buildUserMessage } from "./prompt";
import { isPartnerTrip } from "./readTools";
import { AGENT_TOOLS, isTerminalTool, TERMINAL_ONLY_TOOLS } from "./tools";
import {
  agentTripTag, cleanOptionAnswer, openTurn, preloadedDetail, runReadTool, tripOptionHint, urlKey, withoutOptionTags, type TurnState,
} from "./turn";
import type { AgentDeps, AgentInput, AgentOutcome, AgentRun, ChatMessage, ToolCall } from "./types";
import { readWebPage } from "./webPage";

export const AGENT_DEFAULT_MODEL = "gpt-4.1";
const TOTAL_MS = 60_000;
const PER_CALL_MS = 30_000;
const MIN_CALL_MS = 3_000;
const MAX_ROUNDS = 6;
const MAX_REPAIRS = 1;
// A runaway turn (a huge page read again and again) stops long before it costs real money.
const MAX_TURN_PROMPT_TOKENS = 90_000;
const MAX_OPTIONS = 8;

const DEFERRED_TERMINAL = JSON.stringify({
  ok: false,
  not_done: "This call was made in the same response as read tools, before their results. Nothing was done. Read the results above, then call it again (or ask_user / reply).",
  hint: "Унших хэрэгслийн хариуг харахаас өмнө бичсэн тул хийгдсэнгүй: хариуг уншаад дахин дууд.",
});

export const AGENT_TIMEOUT_NOTE = "AI туслах 60 секундэд амжиж дуусгасангүй — юу ч өөрчлөгдөөгүй. Зааврыг богиносгож (нэг мессежид 1–3 өөрчлөлт) дахин илгээнэ үү.";

export function agentFailureNote(kind: AgentModelFailure | string): string {
  switch (kind) {
    case "timeout": return AGENT_TIMEOUT_NOTE;
    case "credits_exhausted": return "OpenAI-ийн данс дууссан тул AI туслах одоогоор ажиллахгүй байна (данс цэнэглэх хэрэгтэй). Юу ч өөрчлөгдөөгүй.";
    case "unauthorized": case "no_key": return "AI туслахын OpenAI түлхүүр тохируулаагүй эсвэл хүчингүй байна («Систем» хэсгийг шалгана уу). Юу ч өөрчлөгдөөгүй.";
    case "quota": return "OpenAI түр ачаалалтай байна. Хэдэн минутын дараа дахин илгээнэ үү; юу ч өөрчлөгдөөгүй.";
    default: return "AI туслахтай холбогдож чадсангүй. Хэдэн минутын дараа дахин илгээнэ үү; юу ч өөрчлөгдөөгүй.";
  }
}

type Args = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function parseArgs(raw: string): Args {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : {};
  } catch {
    return {};
  }
}

/* ---------------------------------------------------------------- */
/* Guards on what a model's proposal may hold                       */
/* ---------------------------------------------------------------- */

// A price change in the admin's words: a price word or a tugrug amount ("100k", "2,590,000").
const PRICE_WORDS = /үнэ|үнийг|үнийн|төгрөг|₮|мянга|сая|(?<!\p{L})(?:une|uniig|unee|price|fare|myang\p{L}*|saya|tugrug)(?!\p{L})/iu;
const asksPrice = (admin: string): boolean => PRICE_WORDS.test(admin) || amountsInText(admin).length > 0;

// The admin's own words must ask for these, every time: a model that slips in an archive,
// a cancel, a hide or a price rule nobody asked for (from a page, from trip text, by mistake)
// is refused in code. Each entry: the words, and what the refusal calls the change.
const ADMIN_VERBS: Record<string, { words: RegExp | ((admin: string) => boolean); what: string }> = {
  delete: { words: /устга|архив|хая(?:ч|х|аарай)?(?!\p{L})|ustga|arhiv|archive|delete/iu, what: "архивлах" },
  cancel: { words: /цуцал|цуцла|tsutsal|cancel/iu, what: "цуцлах" },
  set_visibility: {
    words: /нуу|идэвх|харагд|харуул|ил\s+болго|гарга|сэргээ|нийтл|idvehgui|idevh|idvh|haragd|haruul|hide|show|nuu|sergee|publish/iu,
    what: "сайтад харуулах, нуух",
  },
  fare_change_all: { words: asksPrice, what: "үнэ өөрчлөх" },
};

// After a web page was read, every edit also needs the admin's words for its kind: a page
// that says "remove the photos" or "rewrite day 1" does not get to do it on the trip he named.
const AFTER_WEB_WORDS: Record<string, RegExp | ((admin: string) => boolean)> = {
  replace_photo: /зураг|зургийг|зургаа|zurag|photo|image|picture/iu,
  patch_itinerary_day: /өдөр|хөтөлбөр|odor|udur|hutulbur|khutulbur|program|(?<!\p{L})day(?!\p{L})/iu,
  set_date_price: asksPrice,
  set_date_state: /дүүр|цөөн|нээ|хаа|зогсоо|суудал|duur|tsoon|nee|haa|full|open|low|pause|seat/iu,
  change_dates: /гаралт|огноо|өдөр|garalt|ognoo|date|departure/iu,
  set_age_bands: /нас|сар|(?<!\p{L})(?:nas|age)(?!\p{L})/iu,
  patch: /нэр|буудал|хоол|суудал|хугацаа|шөнө|хоног|тэмдэглэл|тайлбар|зогсоо|идэвхж|сэргээ|төлөв|(?<!\p{L})(?:ner|buudal|hool|suudal|name|hotel|food|meal|seats?|notes?|status|pause|resume)(?!\p{L})/iu,
};

// Only a catalogue-wide phrase makes a price rule touch every active trip: "бүх аяллын үнийг",
// "аялал бүрийн", "buh aylliin une", "all trips". "Альфагийн бүх үнийг" is one trip's prices.
export const CATALOGUE_WIDE = /(?<!\p{L})(?:бүх|бүгд|нийт)\s+(?:\p{L}+\s+)?аял(?:ал|л)|аялал\s+(?:бүр|болгон)|(?<!\p{L})(?:buh|bvh|bukh)\s+(?:\p{L}+\s+)?ay\p{L}*l|(?<!\p{L})all\s+(?:\p{L}+\s+)?(?:trips|tours)(?!\p{L})|(?<!\p{L})every\s+(?:trip|tour)(?!\p{L})/iu;

const wordsAsk = (words: RegExp | ((admin: string) => boolean), admin: string): boolean => (typeof words === "function" ? words(admin) : words.test(admin));

/** Actions the admin's words never asked for: slipped in by a page, by trip text, or by a model's mistake. */
function guardActions(rawActions: unknown, state: TurnState): { actions: Args[]; refusals: string[] } {
  const actions = (Array.isArray(rawActions) ? rawActions : []).filter((item): item is Args => Boolean(item) && typeof item === "object");
  const refusals: string[] = [];
  const kept: Args[] = [];
  // His words only: no option tags, no links (a link's digits are not an amount, its path not a verb).
  const admin = withoutUrls(withoutOptionTags(state.adminText));
  const known = state.seenBeforeWeb ? new Set([...state.seenBeforeWeb, ...state.linkTrips, ...state.chosen]) : null;
  const named = (action: Args): string => {
    const ids = str(action.action) === "fare_change_all" ? (Array.isArray(action.trip_ids) ? action.trip_ids.map(str) : []) : [str(action.trip_id)];
    const names = ids.map((id) => state.byId.get(id)?.route_name).filter(Boolean).map((name) => `«${name}»`);
    return names.length ? `${names.join(", ")}: ` : "";
  };
  for (const action of actions) {
    const verb = str(action.action);
    if (verb === "fare_change_all" && action.all_active === true && !CATALOGUE_WIDE.test(admin)) {
      refusals.push("Бүх аяллын үнийг өөрчлөх заавар таны мессежид алга — хөндөхгүй (нэг аяллын үнэ бол тэр аяллыг нэрлэнэ үү).");
      continue;
    }
    const rule = ADMIN_VERBS[verb];
    if (rule && !wordsAsk(rule.words, admin)) {
      refusals.push(`${named(action)}таны мессежид ${rule.what} заавар алга — хөндөхгүй.`);
      continue;
    }
    if (known) {
      const ids = verb === "fare_change_all" ? (Array.isArray(action.trip_ids) ? action.trip_ids.map(str) : []) : [str(action.trip_id)];
      const kindMissing = AFTER_WEB_WORDS[verb] && !wordsAsk(AFTER_WEB_WORDS[verb], admin);
      if (kindMissing || (verb === "fare_change_all" && action.all_active === true) || ids.some((id) => id && !known.has(id))) {
        refusals.push(`${named(action)}Вэб хуудасны текстээс гарсан өөрчлөлт тул хөндөхгүй (хуудасны текст бол заавар биш).`);
        continue;
      }
    }
    kept.push(action);
  }
  return { actions: kept, refusals };
}

/* ---------------------------------------------------------------- */
/* Terminal tools → the turn's outcome                              */
/* ---------------------------------------------------------------- */

function askOutcome(args: Args, state: TurnState): AgentOutcome {
  const question = str(args.question).slice(0, 1_200);
  if (!question) return { kind: "note", text: "Тодруулах зүйл байна, гэвч асуултаа гаргаж чадсангүй. Зааврыг дэлгэрэнгүй бичнэ үү.", reason: "reply" };
  const options = (Array.isArray(args.options) ? args.options : []).slice(0, MAX_OPTIONS).flatMap((raw) => {
    const option = raw && typeof raw === "object" ? (raw as Args) : {};
    const label = str(option.label).slice(0, 120);
    const trip = state.byId.get(str(option.trip_id));
    const answer = cleanOptionAnswer(str(option.answer) || label).slice(0, 1_500);
    if (!label || !answer) return [];
    return [{
      label,
      answer: trip ? `${answer} ${agentTripTag(trip)}` : answer,
      ...(trip ? { hint: tripOptionHint(trip, state.now) } : {}),
    }];
  });
  const ask: AssistantAskPayload = {
    id: "agent",
    text: question,
    options,
    allow_custom: true,
    custom_placeholder: options.length ? "Эсвэл хариултаа бичнэ үү…" : "Хариултаа бичнэ үү…",
  };
  return { kind: "ask", ask };
}

async function tripSourceOutcome(args: Args, state: TurnState): Promise<AgentOutcome> {
  // The reader's note is the admin's own message, never words the model (or a page) wrote.
  const note = withoutOptionTags(state.instruction).slice(0, 2_000);
  const key = urlKey(str(args.url));
  if (key) {
    let page = state.pages.get(key);
    const url = state.allowedUrls.get(key);
    if (!page && url) {
      const read = await readWebPage(url, state.deps.safeFetch);
      if (!read.ok) return { kind: "note", text: `Хуудсыг уншиж чадсангүй: ${read.error}`, reason: "refused" };
      page = { url: read.url, title: read.title, text: read.text };
    }
    if (!page) return { kind: "note", text: "Энэ холбоос таны мессежид алга тул уншихгүй. Холбоосыг нь хуулж оруулна уу.", reason: "refused" };
    return { kind: "trip_source", label: (page.title || page.url).slice(0, 200), text: `Эх сурвалж: ${page.url}\nГарчиг: ${page.title}\n\n${page.text}`, note };
  }
  // A pasted program: the admin's own words are the source, never a copy the model re-typed.
  const pasted = withoutOptionTags([state.answerToInstruction, state.instruction].filter(Boolean).join("\n\n"));
  if (pasted.length < 40) return { kind: "note", text: "Шинэ аяллын эх сурвалж алга: хөтөлбөрийн текстийг буулгах, файл эсвэл хуудасны холбоос оруулна уу.", reason: "reply" };
  return { kind: "trip_source", label: "Админы оруулсан текст", text: pasted, note };
}

type Finish = { outcome: AgentOutcome } | { retry: string };

async function finish(calls: ToolCall[], state: TurnState, repairsLeft: number): Promise<Finish> {
  const parsed = calls.map((call) => ({ name: call.function.name, args: parseArgs(call.function.arguments) }));
  const ask = parsed.find((entry) => entry.name === "ask_user");
  if (ask) return { outcome: askOutcome(ask.args, state) };
  const proposes = parsed.filter((entry) => entry.name === "propose_changes");
  if (proposes.length) {
    const guarded = guardActions(proposes.flatMap((entry) => (Array.isArray(entry.args.actions) ? entry.args.actions : [])), state);
    // Everything refused by the guard: say why, never the model's own "will archive" line.
    if (!guarded.actions.length && guarded.refusals.length) {
      return { outcome: { kind: "note", text: `Өөрчлөх зүйл алга. ${[...new Set(guarded.refusals)].join(" ")}`, reason: "refused" } };
    }
    const replyText = proposes.map((entry) => str(entry.args.reply_text)).filter(Boolean).join(" ");
    const built = buildAgentProposal(guarded.actions, replyText, {
      trips: state.trips, now: state.now, fetched: state.fetched, seen: state.seen,
      linkTrips: state.linkTrips, linkUnresolved: state.linkUnresolved, hosted: state.hosted,
    });
    if ("proposal" in built) {
      for (const refusal of guarded.refusals) {
        built.proposal.conflict_items!.push({ text: refusal, severity: "warning", type: "agent_refused" });
        built.proposal.conflicts.push(refusal);
      }
      return { outcome: { kind: "proposal", proposal: built.proposal } };
    }
    if (built.fixable && repairsLeft > 0) {
      return { retry: JSON.stringify({ ok: false, refused: built.note, hint: "Засах боломжтой бол get_trip-ийн бодит өгөгдлөөр дахин propose_changes; тодорхойгүй бол ask_user; болохгүй бол reply-гаар шалтгааныг хэл." }) };
    }
    const text = [built.note, ...guarded.refusals].join(" ").trim();
    return { outcome: { kind: "note", text, reason: "refused" } };
  }
  const source = parsed.find((entry) => entry.name === "read_trip_source");
  if (source) return { outcome: await tripSourceOutcome(source.args, state) };
  const reply = parsed.find((entry) => entry.name === "reply");
  const text = str(reply?.args.text).slice(0, 4_000);
  return { outcome: { kind: "note", text: text || "Ойлгосонгүй. Юуг өөрчлөхийг бичнэ үү.", reason: "reply" } };
}

/* ---------------------------------------------------------------- */
/* The loop                                                         */
/* ---------------------------------------------------------------- */

function timedOut(error: unknown): boolean {
  if (error instanceof AgentModelError) return error.kind === "timeout";
  return error instanceof Error && /time(?:d)?\s*out|abort/i.test(`${error.name} ${error.message}`);
}

export async function runAgent(input: AgentInput): Promise<AgentRun> {
  const deps: AgentDeps = { ...defaultAgentDeps(), ...(input.deps || {}) } as AgentDeps;
  const startedAt = deps.now();
  const now = input.today ?? new Date(startedAt);
  const totalMs = input.totalMs ?? TOTAL_MS;
  const maxRounds = Math.max(1, Math.min(input.maxRounds ?? MAX_ROUNDS, MAX_ROUNDS));
  const model = input.model || process.env.OPENAI_ASSISTANT_MODEL || AGENT_DEFAULT_MODEL;
  const tools: string[] = [];
  const usage = { prompt: 0, completion: 0 };
  const done = (outcome: AgentOutcome, rounds: number, modelFailure?: string): AgentRun => {
    logInfo("assistant.agent.turn", { outcome: outcome.kind, reason: "reason" in outcome ? outcome.reason : undefined, rounds, tools, prompt_tokens: usage.prompt, completion_tokens: usage.completion, duration_ms: deps.now() - startedAt, model });
    return { outcome, tools, rounds, ...(modelFailure ? { modelFailure } : {}) };
  };

  const budget = await deps.budget().catch(() => ({ exceeded: false, message: "" }));
  if (budget.exceeded) return done({ kind: "note", text: budget.message, reason: "budget" }, 0);

  const state = await openTurn(input, deps, now);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    {
      role: "user",
      content: buildUserMessage({
        instruction: input.instruction, now, turns: input.turns, answerTo: input.answerTo, attachments: state.attachments,
        links: state.links, revising: input.revising,
        chosenTrips: [...state.chosen].map((id) => state.byId.get(id)!).map((trip) => ({ id: trip.id, name: trip.route_name, partner: isPartnerTrip(trip) })),
        preloaded: await preloadedDetail(state),
      }),
    },
  ];
  let repairsLeft = MAX_REPAIRS;
  for (let round = 1; round <= maxRounds; round += 1) {
    const remaining = totalMs - (deps.now() - startedAt);
    if (remaining < MIN_CALL_MS) return done({ kind: "note", text: AGENT_TIMEOUT_NOTE, reason: "timeout" }, round - 1, "timeout");
    if (usage.prompt > MAX_TURN_PROMPT_TOKENS) return done({ kind: "note", text: "Энэ даалгавар хэт урт болов — юу ч өөрчлөгдөөгүй. Хэсэг хэсгээр нь илгээнэ үү.", reason: "model_failed" }, round - 1);
    const last = round === maxRounds;
    let result;
    try {
      result = await deps.chat({
        messages, tools: last ? TERMINAL_ONLY_TOOLS : AGENT_TOOLS, toolChoice: "required",
        timeoutMs: Math.max(1_000, Math.min(PER_CALL_MS, remaining - 500)), model, maxOutputTokens: 4_000,
      });
    } catch (error) {
      const kind = timedOut(error) ? "timeout" : error instanceof AgentModelError ? error.kind : "other";
      return done({ kind: "note", text: agentFailureNote(kind), reason: kind === "timeout" ? "timeout" : "model_failed" }, round, kind);
    }
    usage.prompt += result.usage?.prompt_tokens || 0;
    usage.completion += result.usage?.completion_tokens || 0;
    const calls = result.message.tool_calls || [];
    if (!calls.length) {
      const text = String(result.message.content || "").trim();
      return done({ kind: "note", text: text || "Ойлгосонгүй. Юуг өөрчлөхийг бичнэ үү.", reason: "reply" }, round);
    }
    messages.push({ role: "assistant", content: result.message.content ?? null, tool_calls: calls });
    const terminals = calls.filter((call) => isTerminalTool(call.function.name));
    const reads = calls.filter((call) => !isTerminalTool(call.function.name));
    // A proposal, question or answer written in the same breath as reads was written before
    // their results: a get_trip beside it must not count as "looked at" (it would let the model
    // edit a trip it never saw). The reads run; the terminal call is sent back to be made again.
    // Only the new-trip hand-off may ride along: its text is the page or the admin's paste, not the model's.
    const deferred = !last && reads.length > 0 && terminals.some((call) => call.function.name !== "read_trip_source");
    for (const call of calls) {
      tools.push(call.function.name);
      if (isTerminalTool(call.function.name)) {
        if (deferred) messages.push({ role: "tool", tool_call_id: call.id, content: DEFERRED_TERMINAL });
        continue;
      }
      // The last round offered only the finishing tools: a read there is not run.
      const content = last ? JSON.stringify({ error: "Унших хэрэгслийн ээлж дууссан. Байгаа мэдээллээрээ дуусга (propose_changes / ask_user / reply)." })
        : await runReadTool(state, call.function.name, parseArgs(call.function.arguments));
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
    if (!terminals.length || deferred) continue;
    const finished = await finish(terminals, state, last ? 0 : repairsLeft);
    if ("outcome" in finished) return done(finished.outcome, round);
    repairsLeft -= 1;
    for (const call of terminals) messages.push({ role: "tool", tool_call_id: call.id, content: finished.retry });
  }
  return done({ kind: "note", text: "Даалгаврыг дуусгаж чадсангүй — юу ч өөрчлөгдөөгүй. Зааврыг тодорхой бичээд дахин илгээнэ үү.", reason: "model_failed" }, maxRounds);
}
