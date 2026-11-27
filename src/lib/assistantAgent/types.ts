/**
 * Shapes shared by the admin assistant's agent (src/lib/assistantAgent/*).
 *
 * Every outside effect the agent has (the model, the web, Cloudinary, the booking and
 * poster lookups, the clock) comes in through AgentDeps, so the tests run the whole loop
 * on scripted tool calls with no network and no database.
 */
import type { AssistantAskPayload } from "../assistantBrain";
import type { AIChangeProposal, TravelTrip } from "../travelTypes";

export type AgentTurn = { role: "admin" | "assistant"; text: string };

/** The open question a typed answer belongs to (the page sends back what the ask carried). */
export type AnswerTo = {
  id?: string;
  question: string;
  instruction?: string;
  /** The agent's own note written with a dialog of questions, returned with the answers. */
  memo?: string;
  /** The answers to a dialog, one per question in its order (what he chose or typed). */
  answers?: string[];
  /** What each attached file is and which questions were asked (intake.ts packs it, the page echoes it). */
  intake?: string;
};

/** Attached files that are one whole NEW trip: the page sends the original files to the new-trip reader with this note. */
export type NewTripHandoff = { files: string[]; note: string };

/** An image the admin attached, already hosted by the page (a Cloudinary URL). */
export type AgentAttachment = { url: string; kind: "image" };

/**
 * A file the admin attached to an instruction about SAVED trips (an updated program, a schedule and
 * price table, a list of extra information), as the text read from it (documentText.ts). Data for
 * the model, never instructions.
 */
export type AgentDocument = { name: string; text: string };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  /** `raw`: the provider's own content blocks, sent back unchanged on the next call (Claude's thinking blocks must be). */
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; raw?: unknown }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ChatResult = {
  message: { content: string | null; tool_calls?: ToolCall[]; raw?: unknown };
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens?: number; cached_tokens?: number };
  finishReason?: string;
};

export type ChatFn = (input: {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  toolChoice?: "auto" | "required";
  timeoutMs: number;
  model: string;
  maxOutputTokens?: number;
}) => Promise<ChatResult>;

/** The apply track's SSRF-safe fetcher (src/lib/safeFetch.ts). */
export type SafeFetchFn = (url: string, options?: { timeoutMs?: number; maxBytes?: number; accept?: string }) =>
  Promise<{ url: string; status: number; contentType: string; body: Buffer }>;

/** Copies an image (https URL or data: URL) to our Cloudinary and returns the hosted URL. */
export type HostImageFn = (urlOrDataUrl: string) => Promise<string | null>;

export type PosterPhotoView = { hero: string | null; days: Array<{ day: number; photo: string | null }> };

export type AgentDeps = {
  chat: ChatFn;
  safeFetch: SafeFetchFn;
  hostImage: HostImageFn;
  /** One GET with redirect "manual" on our own short-link host: the Location header, or null. */
  shortLinkLocation: (url: string) => Promise<string | null>;
  /** A website slug the catalogue overlay did not know (booking DB / trip_website_sync, read only). */
  slugToTripId: (slug: string) => Promise<string | null>;
  /** The poster's hero and day photos (only those keys are read, never the whole poster). */
  posterPhotos: (posterId: string) => Promise<PosterPhotoView | null>;
  budget: () => Promise<{ exceeded: boolean; message: string }>;
  now: () => number;
  /**
   * A photo for each program day of a saved trip that has none: the agency's own photos of the same
   * places, and with `web` the Wikimedia search (slow). Every url returned is on our Cloudinary.
   */
  findPhotos: (trip: TravelTrip, catalogue: TravelTrip[], options: { web: boolean }) => Promise<FoundDayPhoto[]>;
  /**
   * One vision look at hosted photos (our Cloudinary urls): what each shows, any sign naming the hotel, and which
   * photos look like the same place. Text only; reads nothing else and writes nothing.
   */
  describePhotos?: (urls: string[]) => Promise<string>;
  /** The model this chat runs when the caller names none (the Claude adapter: ASSISTANT_ANTHROPIC_MODEL). */
  defaultModel?: string;
  /**
   * The tool list must stay the same for the whole turn (Claude checks that tools and earlier messages are
   * unchanged since a thinking block): the last round then keeps every tool and is told in words to finish.
   */
  stableTools?: boolean;
};

/** One photo find_photos proposes for a program day. */
export type FoundDayPhoto = { day: number; url: string; source: "house" | "web"; from?: string; credit?: Record<string, unknown> };

/** The stored proposal a clarification is about (a card the admin is still reviewing). */
export type AgentRevision = { requestId: number; instruction: string; proposal: AIChangeProposal };

export type AgentInput = {
  instruction: string;
  trips: TravelTrip[];
  turns?: AgentTurn[];
  answerTo?: AnswerTo | null;
  attachments?: AgentAttachment[];
  /** Files sent with the instruction, as text (at most 6; the page reads them through /api/admin/file-text). */
  documents?: AgentDocument[];
  revising?: AgentRevision | null;
  /** The page asks for the files to be taken stock of first (several files, or one with loose words). Several documents always are. */
  intake?: boolean;
  /** "Today" for dates in the prompt; defaults to deps.now(). */
  today?: Date;
  deps?: Partial<AgentDeps>;
  model?: string;
  /** Total wall-clock budget for the whole loop (default 60 s). */
  totalMs?: number;
  maxRounds?: number;
};

export type AgentOutcome =
  | { kind: "proposal"; proposal: AIChangeProposal; handoffs?: NewTripHandoff[] }
  | { kind: "ask"; ask: AssistantAskPayload }
  /** Only new trips in the attached files: nothing to review here, the page reads each file set as a new trip. */
  | { kind: "handoff"; handoffs: NewTripHandoff[]; text: string }
  | { kind: "note"; text: string; reason?: "timeout" | "budget" | "model_failed" | "reply" | "refused" }
  /**
   * A partner page or pasted program: the router hands it to the new-trip file pipeline. `url` is
   * the page read (none for a paste); the new trip keeps it as extra.source_url (partner watch).
   */
  | { kind: "trip_source"; label: string; text: string; note: string; url?: string };

export type AgentRun = {
  outcome: AgentOutcome;
  /** Tool names in the order the model called them (tests and logs). */
  tools: string[];
  rounds: number;
  /** Set when the model itself could not be reached (the router may fall back to the brain). */
  modelFailure?: string;
};
