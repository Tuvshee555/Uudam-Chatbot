import type { ModelOverride } from "./conversationGateHarness";

/**
 * Types and small building blocks of the conversation-level UNDERSTANDING scenario suite
 * (tests/understanding-scenarios.test.ts). A scenario is a short customer conversation replayed
 * through the signed webhook on an invented catalogue with a mocked model; its expectations are
 * assertable predicates on what the customer would see, never on which branch produced it.
 *
 * Everything here is invented: no real trip, place, price or date (AGENTS.md).
 */

/** The understanding call as the mocked model returns it (keys the harness forwards verbatim). */
export type Model = ModelOverride & Record<string, unknown>;

/**
 * Failure classes. Each failed predicate is reported as "<kind>: <detail>", and the report script
 * derives its metrics from the kinds:
 *  - missing-answer: a fact or a statement the customer needed is not in the reply
 *  - wrong-topic: the reply is about something else (a trip card for a business question, ...)
 *  - wrong-trip: the reply names or sells a trip the customer did not ask about or rejected
 *  - wrong-date: a date or holiday window that is not the one asked
 *  - unsupported-claim: a price, date or policy (discount, barter, ...) the catalogue or settings do not hold
 *  - unnecessary-clarification: a counter-question where the data answers
 *  - silence-on-answerable: nothing sent although the data holds the answer
 *  - human-violation: the bot sent (or spent a model call) while staff own the conversation
 *  - outage-text: the "system is down" notice for a need that never needed the model
 *  - lead / selection / model-calls / reply-count: state and bookkeeping expectations
 */
export type FailureKind =
  | "missing-answer" | "wrong-topic" | "wrong-trip" | "wrong-date" | "unsupported-claim" | "unnecessary-clarification"
  | "silence-on-answerable" | "human-violation" | "outage-text" | "lead" | "selection" | "model-calls" | "reply-count";

export type LeadExpect = {
  /** Lead kind staff must see for this customer by the end of the turn ("handoff", "booking", ...). */
  kind?: string;
  /** What the lead's context must say. */
  contextMatches?: RegExp;
};

/** Assertable predicates on one turn. Anything unset is not checked (except the defaults in the runner). */
export type Expect = {
  /** A reply must be sent. Silence is then a "silence-on-answerable" failure. */
  mustAnswer?: boolean;
  /** Nothing may be sent (the owner's no-data rule, or staff own the chat). */
  silent?: boolean;
  /** Silence passes; every other predicate then applies only if something was sent. */
  allowSilence?: boolean;
  /** Exact number of messages. */
  replyCount?: number;
  /** All must match the concatenated reply. */
  mustMatch?: RegExp[];
  /** At least one must match. */
  anyOf?: RegExp[];
  /** Applied only when a reply was sent. */
  ifReplyMustMatch?: RegExp[];
  /** None may match (wrong-topic). */
  mustNotMatch?: RegExp[];
  /** None may match (unsupported-claim). */
  mustNotClaim?: RegExp[];
  /** Catalogue trip ids whose title must not appear in the reply (wrong-trip). */
  mustNotMentionTripIds?: string[];
  /** Catalogue trip ids whose title must appear in the reply. */
  mustMentionTripIds?: string[];
  /** The reply carries no catalogue content at all: no trip title, no fare, no departure list. */
  noTripContent?: boolean;
  /** The reply must not be a counter-question such as "which trip?". */
  noClarification?: boolean;
  /** The "system is down" notice must not appear (a need that never needed the model). */
  noOutage?: boolean;
  /** Every date printed must fall inside [from, to] (ISO). */
  datesWithin?: [string, string];
  /** Staff must have a lead for this customer (cumulative). */
  lead?: LeadExpect;
  /** If nothing is sent, staff must have a lead for this customer (the owner's no-data rule: silence plus a hand-off lead). */
  leadIfSilent?: boolean;
  /** No lead may be created by this very turn. */
  noNewLead?: boolean;
  /** The stored trip selection after the turn (null = none). */
  selectionAfter?: string | null;
  /** Neither the understanding nor the answer model is called. */
  noModelCalls?: boolean;
  /** Upper bound on understanding + answer model calls. */
  maxModelCalls?: number;
};

export type SelectionSeed = { tripId: string; date?: string | null };

export type Before = {
  /** Store this trip as the customer's selection (as a tapped trip or an ad would). */
  selection?: SelectionSeed | null;
  /** A consultant wrote in the Messenger thread this long ago; from now on staff own the chat. */
  consultantAgoMs?: number;
  /** Staff paused the conversation manually; from now on staff own the chat. */
  pause?: boolean;
  /** Staff handed the conversation back to the bot. */
  resume?: boolean;
  /** The booking website's weather API for this and the following turns. */
  weather?: "ok" | "down";
};

export type Turn = {
  text: string;
  /** What the mocked understanding model returns. Always set topics explicitly (the harness default is price). */
  model?: Model;
  /** Prepares conversation state; produces no verdict. */
  setup?: boolean;
  expect?: Expect;
  before?: Before;
  tags?: string[];
};

export type Scenario = {
  id: string;
  /** "CASE-1" ... "CASE-17" for the owner's historical conversations. */
  historicalCase?: string;
  title: string;
  /** Dimension and group tags, see the report script. */
  tags: string[];
  /** Mocked clock (ISO). Default: the suite's November 2026 clock. */
  at?: string;
  /** Default model for turns that set none. */
  model?: Model;
  /** Applied to every verdict turn after the turn's own expectations. */
  expectAll?: Expect;
  /** Weather API for the whole scenario unless a turn says otherwise. */
  weather?: "ok" | "down";
  /** Applies before the first turn. */
  before?: Before;
  /** The customer already talked to staff this long ago (older than the takeover window). */
  staffHistoryAgoMs?: number;
  /** Instagram instead of Messenger. */
  platform?: "facebook" | "instagram";
  turns: Turn[];
};

/** One row of the machine-readable report (SCENARIO_REPORT). */
export type ReportRow = {
  id: string;
  historicalCase: string | null;
  tags: string[];
  turn: number;
  input: string;
  reply: string;
  route: string | null;
  leadKind: string | null;
  silent: boolean;
  modelCalls: number;
  verdict: "pass" | "fail";
  failedPredicates: string[];
  /** Extras the report script uses. */
  setup: boolean;
  replyCount: number;
  answerModelCalls: number;
  unavailable: boolean;
  staffOwned: boolean;
  selection: string | null;
};

const none: Model = { intent: "other", topics: [], certainty: "none" };
/** Presets of the mocked understanding call. Topics are always explicit. */
export const M = {
  /** The model read the message correctly: not about a catalogue trip. */
  none,
  /** The model read it as small talk. */
  smalltalk: { intent: "smalltalk", topics: [], certainty: "none" } as Model,
  /** The model mislabels any follow-up as a trip question with nothing to point at (prompt rule 4 invites it). */
  mislabel: { intent: "trip", topics: [], certainty: "none" } as Model,
  /** A working reply model closes a polite message with one plain friendly line (the harness default would REFER, which is the mock talking, not the bot). */
  friendly: (reading: Model = { intent: "smalltalk", topics: [], certainty: "none" }): Model => ({ ...reading, finalReply: "Зүгээр ээ 😊 Өөр асуух зүйл байвал чөлөөтэй бичээрэй." }),
  /** The model says "catalogue question, no trip". */
  catalog: { intent: "catalog", topics: [], certainty: "none" } as Model,
  /** The provider refuses every call (credit outage). */
  down: { unavailable: true } as Model,
  /** The model identifies exactly one trip. */
  trip: (tripId: string, topics: string[] = ["price"], extra: Model = {}): Model => ({ intent: "trip", certainty: "one", tripId, topics, ...extra }),
  /** The model names a destination that no trip goes to. */
  unknownPlace: (place: string, topics: string[] = []): Model => ({ intent: "trip", certainty: "none", place, unknown_destination: place, topics }),
  /** The model reads a topic without a trip. */
  topics: (topics: string[], extra: Model = {}): Model => ({ intent: "trip", certainty: "none", topics, ...extra }),
  /** A free-text reply model that invents a commercial policy (what production once sent). */
  invents: (sentence: string, reading: Model = none): Model => ({ ...reading, finalReply: sentence }),
} as const;

/** Recognisers shared by the scenario data and the runner. */
export const RE = {
  outage: /систем түр саатаж/i,
  /** "Which trip?" and its relatives: a counter-question where the data may answer. */
  clarify: /Аль аялал вэ\?|Аль аяллыг(?: нь)? сонирхож байна вэ|Ямар аяллыг сонирхож байгаагаа|Аль байгууллагын аялл|Аль чиглэлийн аялл|аяллын нэр эсвэл чиглэлийг тодруулж|Аль аяллын цаг агаар/i,
  /** A list of trips offered as the answer. */
  tripList: /Аяллууд:|Манай аяллууд|гарах аяллууд|аяллууд:|сонголт бий|аялал бий/i,
  /** The generic "no departure" line with departure days months away. */
  noDepartureHeading: /^Тэр хугацаанд гарах аялал алга/m,
  /** A fare card line. */
  fareLine: /Том хүн[^\n]*₮|Хүүхэд[^\n]*₮|Нярай[^\n]*₮/,
  /** A staff hand-off line (acceptable instead of silence for a business question). */
  handoff: /зөвлөхөд дамжуул|зөвлөх тантай холбогдоно|зөвлөхтэй холбо/i,
} as const;

/** Expectation presets for the need classes that recur. A hand-off line or silence both pass; a trip answer never does. */
export const X = {
  /** A business or group need with no data behind it (corporate group, custom route, barter, discount, contract). */
  business: { allowSilence: true, leadIfSilent: true, noTripContent: true, noClarification: true, noOutage: true } as Expect,
  /** A service the agency does not sell (pick-up, ticket only, transfer, hotel only): silence plus a lead. */
  service: { allowSilence: true, leadIfSilent: true, noTripContent: true, noOutage: true } as Expect,
  /** Thanks, praise, farewell: a friendly line or nothing, no trip content, no staff lead. */
  social: { allowSilence: true, noTripContent: true, noClarification: true, noOutage: true, noNewLead: true } as Expect,
} as const;

/** Scenario helper: tags are the first argument so the data reads as a table. */
export function scenario(tags: string[], fields: Omit<Scenario, "tags">): Scenario {
  return { ...fields, tags };
}
