import type { DiscountPolicy, FAQItem, SpecialOffer, VerifiedCredential } from "./businessData";

export type TripStatus = "active" | "paused" | "cancelled" | "sold_out" | "draft" | "archived";

export type TravelTrip = {
  id: string;
  category: string;
  operator_name: string;
  route_name: string;
  duration_text: string;
  adult_price: number | null;
  child_price: number | null;
  infant_price: number | null;
  currency: string;
  departure_dates: string[];
  seats_total: number | null;
  seats_left: number | null;
  has_food: boolean | null;
  status: TripStatus;
  notes: string;
  hotel: string;
  source_description: string;
  photo_urls: string[];
  extra: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type BotControl = {
  bot_paused: boolean;
  pause_reason: string | null;
  photo_only: boolean;
  updated_at: string;
};

export type PageControl = BotControl & {
  page_id: string;
};

export type ChatButton = {
  label: string;
  message: string;
};

export type TravelBotSettings = {
  business_name: string;
  system_prompt: string;
  quick_info_reply: string;
  quick_info_keywords: string[];
  comment_trigger_patterns: string[];
  comment_public_reply: string;
  comment_dm_reply: string;
  special_offers: SpecialOffer[];
  discount_policies: DiscountPolicy[];
  verified_credentials: VerifiedCredential[];
  faq: FAQItem[];
  handoff_enabled: boolean;
  handoff_keywords: string[];
  handoff_reply: string;
  handoff_pause_minutes: number;
  chat_buttons: ChatButton[];
  extra: Record<string, unknown>;
  updated_at: string;
};

export type TravelBotSettingsUpdate = Partial<
  Omit<TravelBotSettings, "updated_at">
>;

export type TripMutationFields = Partial<
  Pick<
    TravelTrip,
    | "category"
    | "operator_name"
    | "route_name"
    | "duration_text"
    | "adult_price"
    | "child_price"
    | "infant_price"
    | "currency"
    | "departure_dates"
    | "seats_total"
    | "seats_left"
    | "has_food"
    | "status"
    | "notes"
    | "hotel"
    | "source_description"
    | "photo_urls"
    | "extra"
  >
>;

/** How one departure day shows on the website and in the bot: open, few seats left, or sold out. */
export type DateSeatState = "open" | "low" | "full";

export type AITripAction = {
  /**
   * upsert/patch/cancel edit the trip record. set_date_state changes ONE departure day's
   * availability on the website (date + state), delete archives the trip (hidden from the
   * website and the bot, the record and its history kept, restorable by rollback).
   */
  action: "upsert" | "patch" | "cancel" | "set_date_state" | "delete";
  trip_id?: string;
  match?: {
    operator_name?: string;
    route_name?: string;
  };
  fields?: TripMutationFields;
  /** set_date_state: the departure day, YYYY-MM-DD. */
  date?: string;
  /** set_date_state: what that day becomes. */
  state?: DateSeatState;
  /**
   * The trip's updated_at when the proposal was built. Apply refuses the action when the
   * trip changed in between (another admin, the website), so nobody's edit is overwritten.
   */
  expected_updated_at?: string;
};

/** One choice the admin can tap in a proposal question; `answer` is what is sent back. */
export type ProposalQuestionOption = {
  label: string;
  answer: string;
  recommended?: boolean;
  /** A short second line (the trip's status or next date). */
  hint?: string;
};

/**
 * A question the assistant needs answered before the change is exact: which of several
 * trips, which departure day, a missing amount. Built in code with real options, so the
 * admin taps instead of retyping a name, and answered in code when the answer is one of
 * the options (the model is not consulted again).
 */
export type ProposalQuestion = {
  id: string;
  prompt: string;
  detail?: string;
  options: ProposalQuestionOption[];
  allow_custom?: boolean;
  custom_placeholder?: string;
  /** What the answer resolves (for a "which trip" question: the action waiting for its trip). */
  data?: Record<string, unknown>;
};

export type ConflictSeverity = "info" | "warning" | "blocker";

export type ConflictItem = {
  text: string;
  severity: ConflictSeverity;
  type?: string;
  /** Structured facts behind the item (a transport choice's route and current type), for the admin UI. */
  data?: Record<string, unknown>;
};

export type AIChangeProposal = {
  summary: string;
  needs_confirmation: boolean;
  important_reason: string;
  /** Legacy flat list — still populated for back-compat with Drive sync etc. */
  conflicts: string[];
  /**
   * Structured conflict items with severity. When present, admin.tsx uses
   * severity to decide whether to ask a question (blocker) or just show an
   * info/warning box without blocking the save. Optional for back-compat with
   * test fixtures and older code paths that build literals without it.
   */
  conflict_items?: ConflictItem[];
  actions: AITripAction[];
  /**
   * Uploaded-image inventory (filename label → Cloudinary URLs) captured at
   * proposal creation. Kept on the proposal so clarification revisions can
   * deterministically re-attach photos to actions in code — the model never
   * sees or owns these URLs and therefore can never lose them.
   */
  photo_sources?: Array<{ label: string; urls: string[] }>;
  /** Open questions with tappable options (see ProposalQuestion). Empty once everything is exact. */
  questions?: ProposalQuestion[];
};

export type ProposalValidationReport = {
  proposal: AIChangeProposal;
  blocking_conflicts: string[];
  auto_apply_ready: boolean;
};

export type AIProposalFailureResponse = {
  statusCode: 402 | 429 | 503 | 504;
  /** A stable code for the admin page ("ai_credits_exhausted") or an English sentence. */
  error: string;
  /** A sentence for a person, when `error` is a code. */
  message?: string;
  retry_after_ms: number;
};

export type TripMatchSnapshot = Pick<
  TravelTrip,
  | "id"
  | "operator_name"
  | "route_name"
  | "status"
  | "seats_left"
  | "seats_total"
  | "adult_price"
  | "child_price"
  | "currency"
>;

export type LeadKind = "handoff" | "booking";

export type LeadCrmStatus = "new_lead" | "contacted" | "booked" | "no_answer";

export type TravelLead = {
  id: number;
  kind: LeadKind;
  platform: string;
  sender_id: string;
  customer_message: string;
  contact_phone: string;
  context: string;
  status: "new" | "seen";
  lead_status: LeadCrmStatus;
  created_at: string;
  seen_at: string | null;
  /** Latest customer activity (a follow-up reopens an older lead); null on older rows. */
  last_activity_at?: string | null;
  /** A consultant reply seen in the Messenger thread after the lead (operator_reply pause). */
  staff_replied_at?: string | null;
  /** The consultant who took the lead (free text, set in the Leads tab). */
  assigned_to?: string;
  /** The bot is stopped for this customer, and why ("manual", "operator_reply", "booked_customer", …). */
  bot_paused?: boolean;
  bot_pause_reason?: string;
  /** When the bot was stopped, and from where a consultant took over ("staff_mobile", "staff_web"). */
  bot_paused_at?: string;
  bot_takeover_source?: string;
};

export type LeadStats = {
  total: number;
  new_count: number;
  today: number;
  last7days: number;
  last30days: number;
  by_platform: Array<{ platform: string; count: number }>;
  by_kind: Array<{ kind: string; count: number }>;
  daily: Array<{ day: string; count: number }>;
};

export type BroadcastRecord = {
  id: number;
  message: string;
  platform: string;
  sent_count: number;
  failed_count: number;
  status: string;
  created_at: string;
  finished_at: string | null;
};
