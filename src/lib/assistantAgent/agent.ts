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
import { amountsInText, type AskDialogQuestion, type AssistantAskPayload } from "../assistantBrain";
import { buildAgentProposal } from "./actions";
import { defaultAgentDeps } from "./deps";
import { withoutUrls } from "./links";
import { AgentModelError, type AgentModelFailure } from "./openaiTools";
import { buildSystemPrompt, buildUserMessage } from "./prompt";
import { isPartnerTrip } from "./readTools";
import { AGENT_TOOLS, isTerminalTool, TERMINAL_ONLY_TOOLS } from "./tools";
import {
  ASK_TOPICS, fallbackQuestion, fixedChoices, handoffNote as intakeHandoffNote, newTripGroups, packIntake, proposalGaps, squashName, todoLines,
  type Asked, type AskTopic,
} from "./intake";
import {
  agentTripTag, cleanOptionAnswer, intakeContext, openTurn, preloadedDetail, runReadTool, tripOptionHint, urlKey, withoutOptionTags, type TurnState,
} from "./turn";
import type { TravelTrip } from "../travelTypes";
import type { AgentDeps, AgentInput, AgentOutcome, AgentRun, ChatMessage, NewTripHandoff, ToolCall } from "./types";
import { readWebPage } from "./webPage";

export const AGENT_DEFAULT_MODEL = "gpt-4.1";
const TOTAL_MS = 60_000;
const PER_CALL_MS = 30_000;
const MIN_CALL_MS = 3_000;
// A model that thinks first (Claude): one-line instructions get more time; the route allows 180 s.
const THINKING_TOTAL_MS = 100_000;
const THINKING_PER_CALL_MS = 50_000;
const MAX_ROUNDS = 6;
// Taking stock of several files needs more looks: every trip found and opened, each program compared, then the proposal.
const DOCUMENT_MAX_ROUNDS = 9;
const MAX_REPAIRS = 1;
// A runaway turn (a huge page read again and again) stops long before it costs real money.
const MAX_TURN_PROMPT_TOKENS = 90_000;
// A turn with attached files re-reads their text on every round and may write a long section
// (a 60-line price list for two trips): more time, more output, a larger prompt allowance.
const DOCUMENT_TOTAL_MS = 165_000;
const DOCUMENT_PER_CALL_MS = 90_000;
const DOCUMENT_MAX_OUTPUT_TOKENS = 8_000;
const DOCUMENT_MAX_TURN_PROMPT_TOKENS = 260_000;
const MAX_OPTIONS = 8;

const DEFERRED_TERMINAL = JSON.stringify({
  ok: false,
  not_done: "This call was made in the same response as read tools, before their results. Nothing was done. Read the results above, then call it again (or ask_user / reply).",
  hint: "Унших хэрэгслийн хариуг харахаас өмнө бичсэн тул хийгдсэнгүй: хариуг уншаад дахин дууд.",
});

const LAST_ROUND_NOTE = "Энэ бол сүүлийн ээлж: унших хэрэгсэл дахин ажиллахгүй. Байгаа мэдээллээрээ propose_changes, ask_user, reply эсвэл read_trip_source-оор одоо дуусга.";

export const AGENT_TIMEOUT_NOTE = "AI туслах хугацаандаа амжиж дуусгасангүй — юу ч өөрчлөгдөөгүй. Зааврыг богиносгож (нэг мессежид 1–3 өөрчлөлт, эсвэл цөөн файл) дахин илгээнэ үү.";

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
  append_notes: /тайлбар|тэмдэглэл|мэдээлэл|нэм|(?<!\p{L})(?:tailbar|medeelel|nem\p{L}*|notes?|add)(?!\p{L})/iu,
};

// A section is written into a trip's description only when the admin's own words ask to add
// information: a file or page that says "add this to every trip" does not get to.
const NOTES_WORDS = /тайлбар|тэмдэглэл|мэдээлэл|нэм|оруул|шинэчил|шинэчлэ|(?<!\p{L})(?:tailbar|medeelel|nem\p{L}*|oruul\p{L}*|shinechil\p{L}*|notes?|add|update)(?!\p{L})/iu;

// The admin's own words ask to replace a program day's text whole (with a file attached, a day's
// saved wording is otherwise kept: actions.ts itineraryDayAction).
const REWRITE_WORDS = /бүхэлд\s+нь|бүтнээр|дахин\s+бич|шинээр\s+бич|файлын\s+(?:үг|текст)\p{L}*\s+(?:соль|болго|тавь|оруул)|(?<![a-z])(?:rewrite|replace\s+(?:the\s+)?(?:whole|text))/iu;
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
    const listed = Array.isArray(action.trip_ids) ? action.trip_ids.map(str) : [];
    const ids = str(action.action) === "fare_change_all" ? listed : str(action.action) === "append_notes" ? [str(action.trip_id), ...listed] : [str(action.trip_id)];
    const names = [...new Set(ids)].map((id) => state.byId.get(id)?.route_name).filter(Boolean).map((name) => `«${name}»`);
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
    if (verb === "append_notes" && !NOTES_WORDS.test(admin)) {
      refusals.push(`${named(action)}таны мессежид тайлбарт мэдээлэл нэмэх заавар алга — хөндөхгүй.`);
      continue;
    }
    if (known) {
      const listed = Array.isArray(action.trip_ids) ? action.trip_ids.map(str) : [];
      const ids = verb === "fare_change_all" ? listed : verb === "append_notes" ? [str(action.trip_id), ...listed] : [str(action.trip_id)];
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

const MAX_DIALOG_QUESTIONS = 4;
// Every decision the files leave open is asked, even past the usual four.
const MAX_INTAKE_QUESTIONS = 6;
// Times the model is sent back to take stock, to ask, or to fill a gap before the system acts itself.
const MAX_INTAKE_NUDGES = 2;
// The page offers "type your own answer" under every question: a model's own «Өөр» row would be a dead button.
const OTHER_LABEL = /^(?:өөр|өөрөөр|бусад|other|өөр хариулт)[\s.:…]*$/iu;
const RECOMMENDED_SUFFIX = /\s*\((?:recommended|санал болгож буй|зөвлөж буй)\)\s*$/iu;

const recordOf = (value: unknown): Args => (value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : {});

/** A tab's name: at most 28 characters, cut between words («Жининь шинжилгээтэй аяллын ү» was cut mid-word). */
function tabName(value: string): string {
  const name = value.replace(/\s+/g, " ").trim();
  if (name.length <= 28) return name;
  const cut = name.slice(0, 29);
  const space = cut.lastIndexOf(" ");
  return (space >= 8 ? cut.slice(0, space) : name.slice(0, 28)).replace(/[\s,–-]+$/u, "");
}

/** A question the model sent without its topic: the decision its heading and text speak of. */
function topicOf(entry: Args, header: string, text: string): AskTopic | "other" {
  const given = ASK_TOPICS.find((topic) => topic === str(entry.topic));
  if (given) return given;
  if (str(entry.topic) === "other") return "other";
  const words = `${header} ${text}`;
  if (/шинэчлэх|шинэ\s+аялал\s+болгон|аль\s+хэдийн|бүртгэлд\s+байна/iu.test(words)) return "saved_or_new";
  if (/тээвэр|галт\s*тэр|автобус/iu.test(words)) return "transport";
  if (/жагсаалт|нэмэлт\s+(?:шинжилгээ|үйлчилгээ|зүйл)/iu.test(words)) return "extras";
  if (/эсвэл|нэмэгдэнэ|групп/iu.test(words) && /үнэ|юань|₮/iu.test(words)) return "price_remark";
  if (/үнэ|₮|төгрөг/iu.test(words)) return "selling_price";
  return "other";
}

const documentNamed = (state: TurnState, raw: unknown): string => {
  const key = squashName(str(raw));
  if (!key) return "";
  const names = state.documents.map((document) => document.name);
  return names.find((name) => squashName(name) === key) ?? names.find((name) => squashName(name).includes(key) || key.includes(squashName(name))) ?? "";
};
const tripOfFile = (state: TurnState, file: string): TravelTrip | undefined => {
  const entry = state.intake?.files.find((item) => item.file === file);
  return entry?.trip_ids.length === 1 ? state.byId.get(entry.trip_ids[0]) : undefined;
};

type BuiltQuestion = { question: Omit<AskDialogQuestion, "id">; asked: Asked; must: boolean };

/**
 * One question of the dialog. A decision the system knows (update or new, the selling price, the
 * transport, an extras list) gets the system's own choices, the same words every time; the model's
 * choices are used for the rest. An option's `answer` is what the page sends back: the heading, the
 * label, the description, and the trip it names.
 */
function builtQuestion(state: TurnState, input: { header: string; text: string; topic: AskTopic | "other"; file: string; trip?: TravelTrip; options: Args[]; must: boolean }): BuiltQuestion {
  const fixed = fixedChoices(input.topic, input.trip);
  const own: Args[] = fixed?.options.length ? fixed.options.map((option) => ({ ...option })) : input.options;
  // A choice the system always offers with the model's (leave the price for now) is added once.
  const source: Args[] = [...own, ...(fixed?.append || []).filter((extra) => !own.some((option) => str(option.label) === extra.label)).map((option): Args => ({ ...option }))];
  // The answer to "update or new?" names the trip, so the next turn opens exactly that one.
  const tagTrip = input.topic === "saved_or_new" ? input.trip : undefined;
  const options = source.flatMap((option) => {
    const label = str(option.label).replace(RECOMMENDED_SUFFIX, "").slice(0, 90);
    if (!label || OTHER_LABEL.test(label)) return [];
    const description = str(option.description).slice(0, 320);
    const trip = state.byId.get(str(option.trip_id)) ?? tagTrip;
    return [{
      label,
      ...(description ? { description } : {}),
      ...(option.recommended === true ? { recommended: true } : {}),
      answer: `${input.header}: ${label}${description ? ` — ${description}` : ""}${trip ? ` ${agentTripTag(trip)}` : ""}`,
    }];
  }).slice(0, 5);
  // One recommendation at most, and it stands first.
  const first = options.findIndex((option) => option.recommended);
  const ordered = (first > 0 ? [options[first], ...options.filter((_option, at) => at !== first)] : options)
    .map((option, at) => (at > 0 && option.recommended ? { label: option.label, ...(option.description ? { description: option.description } : {}), answer: option.answer } : option));
  // A price question always says which trip it is about (one in the real tab said only "the price").
  const named = input.trip && (input.topic === "price_remark" || input.topic === "selling_price") && !input.text.includes(input.trip.route_name);
  const text = named ? `«${input.trip!.route_name}»: ${input.text}` : input.text;
  return {
    question: { header: input.header, text, options: ordered, ...(fixed?.custom_label ? { custom_label: fixed.custom_label } : {}), ...(fixed?.custom_placeholder ? { custom_placeholder: fixed.custom_placeholder } : {}) },
    asked: { topic: input.topic, header: input.header, ...(input.file ? { file: input.file } : {}), ...(input.trip ? { trip_id: input.trip.id } : {}) },
    must: input.must,
  };
}

/**
 * Several decisions asked together (the stock-taking of attached files): each with a tab heading, the
 * question with its facts, and choices that say what they do. Every decision take_stock found open is
 * asked — the model's own question for it, or the system's when the model left it out.
 */
function dialogQuestions(args: Args, state: TurnState): { questions: AskDialogQuestion[]; asked: Asked[] } {
  const raw = (Array.isArray(args.questions) ? args.questions : []).map(recordOf);
  // A single question asked while decisions are open joins the dialog.
  if (!raw.length && state.mustAsk.length && str(args.question)) {
    raw.push({ topic: "other", header: "Тодруулга", question: args.question, options: (Array.isArray(args.options) ? args.options : []).map(recordOf).map((option) => ({ label: option.label, trip_id: option.trip_id })) });
  }
  const open = [...state.mustAsk];
  const built: BuiltQuestion[] = [];
  raw.forEach((entry, index) => {
    const text = str(entry.question).slice(0, 1_200);
    if (!text) return;
    const header = tabName(str(entry.header)) || `Асуулт ${index + 1}`;
    const topic = topicOf(entry, header, text);
    let file = documentNamed(state, entry.file);
    // The open decision this question asks: the same topic and file, else the first of that topic.
    const at = open.findIndex((item) => item.topic === topic && (!file || item.file === file));
    const must = at >= 0 ? open.splice(at, 1)[0] : undefined;
    if (must) file = must.file;
    const trip = state.byId.get(must?.trip_id || "") ?? tripOfFile(state, file);
    built.push(builtQuestion(state, { header, text, topic, file, trip, options: (Array.isArray(entry.options) ? entry.options : []).map(recordOf), must: Boolean(must) }));
  });
  // What the model left out is asked anyway, in the system's own words.
  const context = intakeContext(state);
  for (const item of open) {
    const fallback = fallbackQuestion(item, context);
    built.push(builtQuestion(state, { ...fallback, topic: item.topic, file: item.file, trip: state.byId.get(item.trip_id || "") ?? tripOfFile(state, item.file), options: fallback.options as unknown as Args[], must: true }));
  }
  const cap = state.mustAsk.length ? Math.min(MAX_INTAKE_QUESTIONS, Math.max(MAX_DIALOG_QUESTIONS, state.mustAsk.length)) : MAX_DIALOG_QUESTIONS;
  // Over the cap, the model's own extra questions give way first.
  let kept = built;
  while (kept.length > cap) {
    const extra = kept.map((entry) => entry.must).lastIndexOf(false);
    kept = extra >= 0 ? kept.filter((_entry, at) => at !== extra) : kept.slice(0, cap);
  }
  return { questions: kept.map((entry, index) => ({ id: `q${index + 1}`, ...entry.question })), asked: kept.map((entry) => entry.asked) };
}

function askOutcome(args: Args, state: TurnState): AgentOutcome {
  const { questions, asked } = dialogQuestions(args, state);
  if (questions.length) {
    const memo = str(args.memo).slice(0, 1_500);
    const ask: AssistantAskPayload = {
      id: "agent",
      // The same questions as plain text: the log, and what a typed answer is read against.
      text: questions.map((question, index) => `${index + 1}) ${question.header}: ${question.text}`).join("\n").slice(0, 2_000),
      options: [],
      allow_custom: true,
      custom_placeholder: "Эсвэл бүгдэд нь нэг дор бичиж хариулна уу…",
      questions,
      ...(memo ? { memo } : {}),
      // What each file is and which decision each question is: comes back with his answers.
      ...(state.intake ? { intake: packIntake({ files: state.intake.files, asked }) } : {}),
    };
    return { kind: "ask", ask };
  }
  const question = str(args.question).slice(0, 1_200);
  if (!question) return { kind: "note", text: "Тодруулах зүйл байна, гэвч асуултаа гаргаж чадсангүй. Зааврыг дэлгэрэнгүй бичнэ үү.", reason: "reply" };
  // A question about ONE trip (which child tier, which date): every option carries that trip, so a
  // tap stays on it even when the option's words do not name it. On 2026-11-14 a tapped
  // «12/9…12/28-ны хүүхэд ор эзлэхгүй…» named no trip and the next turn edited another Chongqing trip.
  // Never on a "which trip?" question: its options are the trips.
  const rawOptions = Array.isArray(args.options) ? args.options : [];
  const asksWhichTrip = /аль\s+(?:\S+\s+){0,2}аял/iu.test(question)
    || rawOptions.some((raw) => raw && typeof raw === "object" && str((raw as Args).trip_id));
  const focusIds = state.chosen.size === 1 ? [...state.chosen] : state.fetched.size === 1 ? [...state.fetched.keys()] : [];
  const focus = !asksWhichTrip && focusIds.length === 1 ? state.byId.get(focusIds[0]) : undefined;
  const options = rawOptions.slice(0, MAX_OPTIONS).flatMap((raw) => {
    const option = raw && typeof raw === "object" ? (raw as Args) : {};
    const label = str(option.label).slice(0, 120);
    const trip = state.byId.get(str(option.trip_id)) ?? focus;
    const answer = cleanOptionAnswer(str(option.answer) || label).slice(0, 1_500);
    if (!label || !answer) return [];
    return [{
      label,
      answer: trip ? `${answer} ${agentTripTag(trip)}` : answer,
      ...(trip && trip !== focus ? { hint: tripOptionHint(trip, state.now) } : {}),
    }];
  });
  const ask: AssistantAskPayload = {
    id: "agent",
    text: question,
    options,
    allow_custom: true,
    custom_placeholder: options.length ? "Эсвэл хариултаа бичнэ үү…" : "Хариултаа бичнэ үү…",
    ...(state.intake ? { intake: packIntake({ files: state.intake.files, asked: [] }) } : {}),
  };
  return { kind: "ask", ask };
}


/**
 * What the new-trip reader is told with a handed-off file: the admin's own decisions and nothing
 * the model wrote. After a dialog these are the answers the model points at by number (the price
 * and the transport of THIS trip, not another trip's); otherwise his whole message.
 */
function handoffNote(state: TurnState, numbers: unknown): string {
  const said = state.answers;
  if (!said.length) return withoutOptionTags(state.instruction).slice(0, 2_000);
  const picked = (Array.isArray(numbers) ? numbers : []).map(Number)
    .filter((value, index, all) => Number.isInteger(value) && value >= 1 && value <= said.length && all.indexOf(value) === index)
    .map((value) => said[value - 1]);
  return ["Шинэ аялал болгон нэм.", ...(picked.length ? picked : said)].map((line) => withoutOptionTags(line)).join("\n").slice(0, 2_000);
}

/**
 * Attached files the model calls whole NEW trips: the page sends the ORIGINAL files to the
 * new-trip reader (a poster is read as a picture there, not as our transcription of it).
 * A name the turn does not hold is dropped; a file is handed off once.
 */
function newTripHandoffs(raw: unknown, state: TurnState): NewTripHandoff[] {
  const byName = new Map(state.documents.map((document) => [squashName(document.name), document.name]));
  const taken = new Set<string>();
  const out: NewTripHandoff[] = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, 4) : []) {
    const entry = item && typeof item === "object" ? (item as Args) : {};
    const files = (Array.isArray(entry.files) ? entry.files : []).map((name) => {
      const key = squashName(str(name));
      return key ? byName.get(key) ?? [...byName.entries()].find(([known]) => known.includes(key) || key.includes(known))?.[1] ?? "" : "";
    }).filter((name) => name && !taken.has(name));
    if (!files.length) continue;
    for (const name of files) taken.add(name);
    out.push({ files: [...new Set(files)], note: handoffNote(state, entry.answers) });
  }
  return out;
}

/**
 * The new trips among the attached files, each with the note its reader gets. Once the files were taken
 * stock of, the system knows them itself (a file the model forgot to list is not lost) and the note holds
 * the admin's decisions about THAT trip in plain words; otherwise the model's list, as before.
 */
function handoffsFor(state: TurnState, raw: unknown): NewTripHandoff[] {
  if (state.intake) {
    const groups = newTripGroups(state.intake.files, state.decisions, state.documents);
    const words = withoutOptionTags(state.answerToInstruction || state.instruction);
    const textOf = (files: string[]) => state.documents.filter((document) => files.includes(document.name)).map((document) => document.text).join("\n");
    if (groups.length) return groups.map((files) => ({ files, note: intakeHandoffNote(files, state.decisions, words, textOf(files), state.now) }));
    // A file the stock-taking called a saved trip's is never read as a new one.
    const saved = new Set(state.intake.files.filter((file) => file.kind !== "new_trip" && file.kind !== "other").map((file) => file.file));
    return newTripHandoffs(raw, state).map((handoff) => ({ ...handoff, files: handoff.files.filter((name) => !saved.has(name)) })).filter((handoff) => handoff.files.length);
  }
  return newTripHandoffs(raw, state);
}

async function tripSourceOutcome(args: Args, state: TurnState): Promise<AgentOutcome> {
  // Attached files that are a new trip go to the reader as the files they are.
  if (!str(args.url) && state.documents.length) {
    const named = handoffsFor(state, [{ files: args.files, answers: args.answers }]);
    const handoffs = named.length ? named : [{ files: state.documents.map((document) => document.name), note: handoffNote(state, args.answers) }];
    return { kind: "handoff", handoffs, text: "" };
  }
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
    return { kind: "trip_source", label: (page.title || page.url).slice(0, 200), text: `Эх сурвалж: ${page.url}\nГарчиг: ${page.title}\n\n${page.text}`, note, url: page.url };
  }
  // A pasted program: the admin's own words are the source, never a copy the model re-typed.
  const pasted = withoutOptionTags([state.answerToInstruction, state.instruction].filter(Boolean).join("\n\n"));
  if (pasted.length < 40) return { kind: "note", text: "Шинэ аяллын эх сурвалж алга: хөтөлбөрийн текстийг буулгах, файл эсвэл хуудасны холбоос оруулна уу.", reason: "reply" };
  return { kind: "trip_source", label: "Админы оруулсан текст", text: pasted, note };
}

const MEAL_NAMES: Record<string, string> = { breakfast: "өглөөний цай", lunch: "өдрийн хоол", dinner: "оройн хоол" };
const included = (value: boolean | null) => (value === true ? "багтсан" : value === false ? "багтаагүй" : "тодорхойгүй");

/**
 * The differences compare_program found that the proposal leaves as they are: a meal the file states
 * differently (staff may have set it on purpose), days only one side has. One line each, for the card.
 */
function comparisonNotes(state: TurnState, tripIds: string[]): string[] {
  const notes: string[] = [];
  for (const id of new Set(tripIds)) {
    const compared = state.compared.get(id);
    const name = state.byId.get(id)?.route_name;
    if (!compared || !name) continue;
    for (const day of compared.days) {
      for (const meal of day.meals_differ || []) {
        notes.push(`«${name}» ${day.saved_day}-р өдөр: файлд ${MEAL_NAMES[meal.meal]} ${included(meal.file)} гэжээ, хадгалсан нь ${included(meal.saved)} — хоолыг өөрчлөөгүй. Өөрчлөх бол «${day.saved_day}-р өдрийн ${MEAL_NAMES[meal.meal]} ${included(meal.file)} болго» гэж бичнэ үү.`);
      }
    }
    if (compared.file_days_beyond_saved.length) notes.push(`«${name}»: файлд хадгалсан хөтөлбөрөөс илүү ${compared.file_days_beyond_saved.length} өдөр байна (файлын ${compared.file_days_beyond_saved.join(", ")}-р өдөр) — өдөр нэмээгүй.`);
    if (compared.saved_days_not_in_file.length) notes.push(`«${name}»: хадгалсан ${compared.saved_days_not_in_file.join(", ")}-р өдөр файлд алга — өдөр хасаагүй.`);
  }
  return notes;
}
/** `nudge`: the model is sent back by the stock-taking rules (counted apart from the repairs of a refused proposal). */
type Finish = { outcome: AgentOutcome } | { retry: string; nudge?: boolean };

const TAKE_STOCK_FIRST = JSON.stringify({
  ok: false,
  not_done: "Files are attached: first call take_stock with what EVERY attached file is (after search_trips / get_trip / compare_program showed you). The system then says what to ask the admin and what to do. Nothing was saved or asked.",
});

async function finish(calls: ToolCall[], state: TurnState, repairsLeft: number, canNudge = false): Promise<Finish> {
  const parsed = calls.map((call) => ({ name: call.function.name, args: parseArgs(call.function.arguments) }));
  const ask = parsed.find((entry) => entry.name === "ask_user");
  const proposes = parsed.filter((entry) => entry.name === "propose_changes");
  const source = parsed.find((entry) => entry.name === "read_trip_source");
  const nudge = (retry: string): Finish => {
    state.intakeNudges += 1;
    return { retry, nudge: true };
  };
  // Files to take stock of: what each file is comes before any question or proposal (intake.ts).
  if ((ask || proposes.length || source) && state.intakeRequired && !state.intake && canNudge) return nudge(TAKE_STOCK_FIRST);
  if (ask) return { outcome: askOutcome(ask.args, state) };
  // Decisions only the admin can make come before any change: asked by the model, or by the system itself.
  if ((proposes.length || source) && state.mustAsk.length && !state.answering) {
    if (canNudge) {
      return nudge(JSON.stringify({ ok: false, not_done: "These decisions are the admin's: ask them first with ONE ask_user questions[] (one question per entry, with its topic and file). Nothing was proposed.", must_ask: state.mustAsk.map((item) => ({ topic: item.topic, file: item.file, why: item.why })) }));
    }
    return { outcome: askOutcome({}, state) };
  }
  if (proposes.length) {
    const guarded = guardActions(proposes.flatMap((entry) => (Array.isArray(entry.args.actions) ? entry.args.actions : [])), state);
    // Files that are whole new trips ride along: each becomes its own review card on the page.
    const handoffs = handoffsFor(state, proposes.flatMap((entry) => (Array.isArray(entry.args.new_trips) ? entry.args.new_trips : [])));
    const replyText = proposes.map((entry) => str(entry.args.reply_text)).filter(Boolean).join(" ");
    // His message sets a price («нярай үнэгүй», «100 мянгаар нэм») and the proposal changes none: sent back once.
    // On 2026-11-22 a first proposal was refused for another part and its rewrite dropped «нярай … үнэгүй».
    if (!state.documents.length && !state.fareNudged && canNudge && setsPrice(withoutOptionTags(state.instruction)) && !changesFare(proposes.flatMap((entry) => (Array.isArray(entry.args.actions) ? entry.args.actions.map(recordOf) : [])))) {
      state.fareNudged = true;
      return { retry: JSON.stringify({ ok: false, not_done: "His message also sets a price (an amount, or «үнэгүй» = set 0), but no action changes a fare. Nothing was proposed.", hint: "Call propose_changes again with EVERY part of his message: the fare (fare_change_all or set_date_price) AND the other changes. If the price really must stay, say why in reply_text." }), nudge: true };
    }
    // What the files and his decisions call for but the proposal lacks: sent back once or twice, then said on the card.
    const gaps = state.intake ? proposalGaps({ intake: state.intake, decisions: state.decisions, actions: guarded.actions, context: intakeContext(state), compared: new Set(state.compared.keys()), now: state.now }) : [];
    if (gaps.length && canNudge) {
      return nudge(JSON.stringify({ ok: false, not_done: "The proposal is not complete yet. Nothing was proposed.", missing: gaps.map((gap) => gap.model), hint: "Add what is missing and call propose_changes again with EVERY action (the earlier ones too)." }));
    }
    const gapLines = gaps.map((gap) => gap.admin);
    // Only new trips, no change of a saved trip: the hand-off is the whole answer.
    if (!guarded.actions.length && !guarded.refusals.length && handoffs.length) return { outcome: { kind: "handoff", handoffs, text: [replyText, ...gapLines].filter(Boolean).join(" ") } };
    // Everything refused by the guard: say why, never the model's own "will archive" line.
    if (!guarded.actions.length && guarded.refusals.length) {
      const text = `Өөрчлөх зүйл алга. ${[...new Set(guarded.refusals)].join(" ")}`;
      return { outcome: handoffs.length ? { kind: "handoff", handoffs, text } : { kind: "note", text, reason: "refused" } };
    }
    const built = buildAgentProposal(guarded.actions, replyText, {
      trips: state.trips, now: state.now, fetched: state.fetched, seen: state.seen,
      linkTrips: state.linkTrips, linkUnresolved: state.linkUnresolved, hosted: state.hosted,
      adminText: withoutUrls(withoutOptionTags(state.adminText)), pinned: state.chosen, photoCredits: state.photoCredits, comparedFileDays: state.comparedFileDays,
      fileTurn: state.documents.length > 0, rewriteAsked: REWRITE_WORDS.test(withoutUrls(withoutOptionTags(state.adminText))),
      // Where a description section's numbers may come from: his words, his files, and the saved
      // descriptions he had opened (one trip's list copied to another).
      sources: [state.adminText, ...state.documents.map((document) => document.text), ...[...state.fetched.keys()].map((id) => state.byId.get(id)?.notes || "")],
      bandSources: [state.adminText, ...state.documents.map((document) => document.text)],
    });
    if ("proposal" in built) {
      // What the file states differently but was left alone (meals, days only one side has): said on the card by code.
      for (const note of comparisonNotes(state, built.proposal.actions.map((action) => str(action.trip_id)))) {
        built.proposal.conflict_items!.push({ text: note, severity: "info", type: "program_compare_note" });
        built.proposal.conflicts.push(note);
      }
      for (const refusal of guarded.refusals) {
        built.proposal.conflict_items!.push({ text: refusal, severity: "warning", type: "agent_refused" });
        built.proposal.conflicts.push(refusal);
      }
      for (const line of gapLines) {
        built.proposal.conflict_items!.push({ text: line, severity: "warning", type: "intake_gap" });
        built.proposal.conflicts.push(line);
      }
      return { outcome: { kind: "proposal", proposal: built.proposal, ...(handoffs.length ? { handoffs } : {}) } };
    }
    if (built.fixable && repairsLeft > 0) {
      return { retry: JSON.stringify({ ok: false, refused: built.note, hint: "Засах боломжтой бол get_trip-ийн бодит өгөгдлөөр дахин propose_changes — БҮХ өөрчлөлтөө (зөв байсан хэсгийг ч, new_trips-ээ ч) дахин бич; тодорхойгүй бол ask_user; болохгүй бол reply-гаар шалтгааныг хэл." }) };
    }
    const text = [built.note, ...guarded.refusals].join(" ").trim();
    // The saved-trip part failed; the new trips of the same message are still read.
    return { outcome: handoffs.length ? { kind: "handoff", handoffs, text } : { kind: "note", text, reason: "refused" } };
  }
  if (source) return { outcome: await tripSourceOutcome(source.args, state) };
  const reply = parsed.find((entry) => entry.name === "reply");
  const text = str(reply?.args.text).slice(0, 4_000);
  return { outcome: { kind: "note", text: withComparedTrips(text || "Ойлгосонгүй. Юуг өөрчлөхийг бичнэ үү.", state), reason: "reply" } };
}

/** His words set a price: «үнэгүй» (free) or an amount beside a price word. */
function setsPrice(admin: string): boolean {
  return /үнэгүй|(?:^|[^a-z])uneg[uү]i/iu.test(admin) || (PRICE_WORDS.test(admin) && amountsInText(admin).length > 0);
}

/** Some action changes a fare: a trip-wide or one-date price, or a price field. */
function changesFare(actions: Args[]): boolean {
  return actions.some((action) => ["fare_change_all", "set_date_price"].includes(str(action.action))
    || Object.keys(recordOf(action.fields)).some((key) => /_price$/.test(key)));
}

const COMPARED_STATUS: Record<string, string> = { active: "сайтад идэвхтэй", archived: "архивт", paused: "түр зогссон", sold_out: "дүүрсэн", draft: "ноорог", cancelled: "цуцалсан" };

/**
 * An answer about an attached program says which saved trip it was compared with and whether that
 * trip is live: on 2026-11-22 «аяллын хөтөлбөрийг энэ файлаар шинэчил» was answered "everything
 * matches" without naming the trip (the owner wants it to say "this trip is already live").
 */
function withComparedTrips(text: string, state: TurnState): string {
  if (!state.documents.length) return text;
  const trips = [...state.compared.keys()].map((id) => state.byId.get(id)).filter((trip): trip is TravelTrip => Boolean(trip) && !text.includes(trip!.route_name));
  if (!trips.length) return text;
  return `${text}\n\nТулгасан аялал: ${trips.map((trip) => `«${trip.route_name}» (${[COMPARED_STATUS[trip.status] || trip.status, str(trip.duration_text)].filter(Boolean).join(", ")})`).join("; ")}.`;
}

/** For his answers to questions about files: the decisions, and the work each file means (intake.ts). */
function intakeBrief(state: TurnState): string[] | undefined {
  if (!state.intake || !state.answering) return undefined;
  const decisions = state.decisions.map((decision) => `- ${decision.header}${decision.file ? ` («${decision.file}»)` : ""}: ${decision.text}`);
  const work = todoLines(state.intake, state.decisions, intakeContext(state)).map((line) => `- ${line}`);
  return [
    ...(decisions.length ? ["Админы шийдвэр, асуулт бүрээр:", ...decisions] : []),
    "Файл бүрийн ажил (систем таны take_stock болон түүний хариултаас гаргасан — яг үүнийг хий; шинэ аяллыг систем өөрөө уншуулна):", ...work,
  ];
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
  const withDocuments = Array.isArray(input.documents) && input.documents.some((document) => document && typeof document.text === "string" && document.text.trim());
  // Claude thinks before it answers: a one-line instruction took 8–39 s on 2026-11-22, so it gets more time per call.
  const thinks = deps.stableTools === true;
  let totalMs = input.totalMs ?? (withDocuments ? DOCUMENT_TOTAL_MS : thinks ? THINKING_TOTAL_MS : TOTAL_MS);
  const perCallMs = withDocuments ? DOCUMENT_PER_CALL_MS : thinks ? THINKING_PER_CALL_MS : PER_CALL_MS;
  const maxTurnPromptTokens = withDocuments ? DOCUMENT_MAX_TURN_PROMPT_TOKENS : MAX_TURN_PROMPT_TOKENS;
  const roundCap = withDocuments ? DOCUMENT_MAX_ROUNDS : MAX_ROUNDS;
  const maxRounds = Math.max(1, Math.min(input.maxRounds ?? roundCap, roundCap));
  const model = input.model || deps.defaultModel || process.env.OPENAI_ASSISTANT_MODEL || AGENT_DEFAULT_MODEL;
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
        documents: state.documents, links: state.links, revising: input.revising,
        chosenTrips: [...state.chosen].map((id) => state.byId.get(id)!).map((trip) => ({ id: trip.id, name: trip.route_name, partner: isPartnerTrip(trip) })),
        preloaded: await preloadedDetail(state),
        intake: intakeBrief(state),
      }),
    },
  ];
  let repairsLeft = MAX_REPAIRS;
  for (let round = 1; round <= maxRounds; round += 1) {
    const remaining = totalMs - (deps.now() - startedAt);
    if (remaining < MIN_CALL_MS) return done({ kind: "note", text: AGENT_TIMEOUT_NOTE, reason: "timeout" }, round - 1, "timeout");
    if (usage.prompt > maxTurnPromptTokens) return done({ kind: "note", text: "Энэ даалгавар хэт урт болов — юу ч өөрчлөгдөөгүй. Хэсэг хэсгээр нь илгээнэ үү.", reason: "model_failed" }, round - 1);
    const last = round === maxRounds;
    // A chat whose tool list must not change (Claude) keeps every tool on the last round and is told in words.
    if (last && deps.stableTools && round > 1) messages.push({ role: "user", content: LAST_ROUND_NOTE });
    let result;
    try {
      result = await deps.chat({
        messages, tools: last && !deps.stableTools ? TERMINAL_ONLY_TOOLS : AGENT_TOOLS, toolChoice: "required",
        timeoutMs: Math.max(1_000, Math.min(perCallMs, remaining - 500)), model, maxOutputTokens: withDocuments ? DOCUMENT_MAX_OUTPUT_TOKENS : 4_000,
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
    messages.push({ role: "assistant", content: result.message.content ?? null, tool_calls: calls, ...(result.message.raw !== undefined ? { raw: result.message.raw } : {}) });
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
      // The web photo search takes up to a minute: the turn is given the long budget once it ran.
      if (state.slow && input.totalMs === undefined) totalMs = Math.max(totalMs, DOCUMENT_TOTAL_MS);
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
    if (!terminals.length || deferred) continue;
    const finished = await finish(terminals, state, last ? 0 : repairsLeft, !last && state.intakeNudges < MAX_INTAKE_NUDGES);
    if ("outcome" in finished) return done(finished.outcome, round);
    if (!finished.nudge) repairsLeft -= 1;
    for (const call of terminals) messages.push({ role: "tool", tool_call_id: call.id, content: finished.retry });
  }
  return done({ kind: "note", text: "Даалгаврыг дуусгаж чадсангүй — юу ч өөрчлөгдөөгүй. Зааврыг тодорхой бичээд дахин илгээнэ үү.", reason: "model_failed" }, maxRounds);
}
