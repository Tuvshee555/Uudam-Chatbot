import type {
  DiscountPolicy,
  FAQItem,
  KnowledgeData,
  ProgramPrice,
  SpecialOffer,
  VerifiedCredential,
} from "./businessData";

export type TripStatus = "active" | "cancelled" | "sold_out" | "draft";

export type TravelTrip = {
  id: string;
  category: string;
  operator_name: string;
  route_name: string;
  duration_text: string;
  adult_price: number | null;
  child_price: number | null;
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

export type AITripAction = {
  action: "upsert" | "patch" | "cancel";
  trip_id?: string;
  match?: {
    operator_name?: string;
    route_name?: string;
  };
  fields?: TripMutationFields;
};

export type ConflictSeverity = "info" | "warning" | "blocker";

export type ConflictItem = {
  text: string;
  severity: ConflictSeverity;
  type?: string;
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
};

export type ProposalValidationReport = {
  proposal: AIChangeProposal;
  blocking_conflicts: string[];
  auto_apply_ready: boolean;
};

export type AIProposalFailureResponse = {
  statusCode: 429 | 503 | 504;
  error: string;
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
