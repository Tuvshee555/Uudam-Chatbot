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
export type AnswerTo = { id?: string; question: string; instruction?: string };

/** An image the admin attached, already hosted by the page (a Cloudinary URL). */
export type AgentAttachment = { url: string; kind: "image" };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ChatResult = {
  message: { content: string | null; tool_calls?: ToolCall[] };
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
};

/** The stored proposal a clarification is about (a card the admin is still reviewing). */
export type AgentRevision = { requestId: number; instruction: string; proposal: AIChangeProposal };

export type AgentInput = {
  instruction: string;
  trips: TravelTrip[];
  turns?: AgentTurn[];
  answerTo?: AnswerTo | null;
  attachments?: AgentAttachment[];
  revising?: AgentRevision | null;
  /** "Today" for dates in the prompt; defaults to deps.now(). */
  today?: Date;
  deps?: Partial<AgentDeps>;
  model?: string;
  /** Total wall-clock budget for the whole loop (default 60 s). */
  totalMs?: number;
  maxRounds?: number;
};

export type AgentOutcome =
  | { kind: "proposal"; proposal: AIChangeProposal }
  | { kind: "ask"; ask: AssistantAskPayload }
  | { kind: "note"; text: string; reason?: "timeout" | "budget" | "model_failed" | "reply" | "refused" }
  /** A partner page or pasted program: the router hands it to the new-trip file pipeline. */
  | { kind: "trip_source"; label: string; text: string; note: string };

export type AgentRun = {
  outcome: AgentOutcome;
  /** Tool names in the order the model called them (tests and logs). */
  tools: string[];
  rounds: number;
  /** Set when the model itself could not be reached (the router may fall back to the brain). */
  modelFailure?: string;
};
