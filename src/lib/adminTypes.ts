/* ----------------------------------------------------------------
   Shared admin-panel types — extracted from src/pages/admin.tsx
   so that sub-files and utilities can import without a circular dep.
   ---------------------------------------------------------------- */

export type TripStatus = "active" | "cancelled" | "sold_out" | "draft";

export type PassengerPrice = {
  label: string;      // "Том хүн" | "Хүүхэд" | "Нярай"
  age_range: string;
  price: number | null;
  currency: string;
};

export type SourceProvenance = {
  file_name: string;
  page: number | null;
  source_text: string;
  confidence: "high" | "medium" | "low";
};

export type AnswerHint = {
  intent: "price" | "discount" | "comparison" | "child_price" | "included" | "schedule";
  question_pattern: string;
  expected_answer_summary: string;
};

export type PriceGroup = {
  label: string;
  dates: string[];
  display_dates: string[];
  date_keys: string[];
  adult_price: number | null;
  child_price: number | null;
  infant_price: number | null;
  child_age: string;
  infant_age: string;
  passenger_prices: PassengerPrice[];
  note: string;
};

export type DiscountGroup = {
  label: string;
  dates: string[];
  display_dates: string[];
  date_keys: string[];
  adult_price: number | null;
  child_price: number | null;
  infant_price: number | null;
  condition: string;
  note: string;
};

export type ChildRule = {
  label: string;
  age_range: string;
  price: number | null;
  currency: string;
  note: string;
};

export type ExtraFee = {
  label: string;
  amount: number | null;
  currency: string;
  applies_to: string;
  note: string;
};

export type RoomPrice = {
  room_type: string;
  price: number | null;
  currency: string;
  note: string;
};

/** Booking terms a customer asks before committing. Freeform Mongolian strings. */
export type BookingTerms = {
  deposit: string;
  payment: string;
  documents: string;
  visa: string;
  cancellation: string;
};

export function emptyBookingTerms(): BookingTerms {
  return { deposit: "", payment: "", documents: "", visa: "", cancellation: "" };
}

/** Coerces any stored/AI value into a complete BookingTerms for the form. */
export function toBookingTermsForm(raw: unknown): BookingTerms {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    deposit: str(src.deposit),
    payment: str(src.payment),
    documents: str(src.documents),
    visa: str(src.visa),
    cancellation: str(src.cancellation),
  };
}

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
  customer_visible: boolean;
  notes: string;
  hotel: string;
  source_description: string;
  photo_urls: string[];
  extra: Record<string, unknown>;
  updated_at: string;
  aliases: string[];
  price_groups: PriceGroup[];
  discounts: DiscountGroup[];
  child_rules: ChildRule[];
  extra_fees: ExtraFee[];
  departure_rule: string;
  included_items: string[];
  excluded_items: string[];
  room_prices: RoomPrice[];
  important_notes: string[];
  source_provenance: SourceProvenance[];
  answer_hints: AnswerHint[];
  needs_human_review: boolean;
  review_reasons: string[];
};

export type PauseRow = {
  sender_id: string;
  display_name?: string;
  paused_at: string;
  expires_at: string | null;
  reason?: string;
};

export type RecentRow = { sender_id: string; last_seen: string; display_name?: string };

export type ControlState = {
  bot_paused: boolean;
  pause_reason: string | null;
  photo_only: boolean;
  updated_at: string;
};

export type PageControlState = ControlState & {
  page_id: string;
  display_name: string;
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
  special_offers: Record<string, unknown>[];
  discount_policies: Record<string, unknown>[];
  verified_credentials: Record<string, unknown>[];
  faq: Record<string, unknown>[];
  handoff_enabled: boolean;
  handoff_keywords: string[];
  handoff_reply: string;
  handoff_pause_minutes: number;
  chat_buttons: ChatButton[];
  extra: Record<string, unknown>;
  updated_at: string;
};

export type StructuredRow = Record<string, string>;

export type SettingsForm = {
  business_name: string;
  system_prompt: string;
  quick_info_reply: string;
  quick_info_keywords: string;
  comment_trigger_patterns: string;
  comment_public_reply: string;
  comment_dm_reply: string;
  special_offers: StructuredRow[];
  discount_policies: StructuredRow[];
  verified_credentials: StructuredRow[];
  faq: StructuredRow[];
  handoff_enabled: boolean;
  handoff_keywords: string;
  handoff_reply: string;
  handoff_pause_minutes: string;
  chat_buttons: ChatButton[];
};

export type AIAction = {
  action: string;
  trip_id?: string;
  match?: { operator_name?: string; route_name?: string };
  fields?: Record<string, unknown>;
};

export type ConflictSeverity = "info" | "warning" | "blocker";

export type ConflictItem = {
  text: string;
  severity: ConflictSeverity;
  type?: string;
};

export type AIProposal = {
  summary: string;
  needs_confirmation: boolean;
  important_reason: string;
  conflicts: string[];
  conflict_items?: ConflictItem[];
  actions: AIAction[];
  photo_sources?: Array<{ label: string; urls: string[] }>;
};

export type AIProposalResponse = {
  proposal?: AIProposal;
  request_id?: number;
  error?: string;
  message?: string;
  retry_after_ms?: number;
  max_chars?: number;
  max_bytes?: number;
  max_file_bytes?: number;
  max_total_bytes?: number;
  max_uploads?: number;
  max_drive_files?: number;
  reset?: number;
};

export type ClarificationOption = {
  label: string;
  answer: string;
  /** Pre-selected + visually highlighted as the safe default (like Claude's
   *  AskUserQuestion "(Recommended)" option) — admin can still tap another. */
  recommended?: boolean;
};

export type ClarificationQuestion = {
  id: string;
  prompt: string;
  detail?: string;
  options: ClarificationOption[];
  allowCustom?: boolean;
  customPlaceholder?: string;
};

export type ClarificationAnswer = {
  questionId: string;
  prompt: string;
  answer: string;
};

export type AdminMsg = {
  id: string;
  role: "admin";
  text: string;
  fileNames?: string[];
};

export type ProposalMsg = {
  id: string;
  role: "assistant";
  kind: "proposal";
  proposal: AIProposal;
  requestId: number | null;
  instruction: string;
  sourceNames?: string[];
  /** Stored source text for file-based proposals so clarifications can re-run generation. */
  sourceText?: string;
  status: "pending" | "applied" | "reverted" | "cancelled" | "error";
  confirmChecked: boolean;
  resultText?: string;
  clarifications: ClarificationQuestion[];
  clarificationAnswers: ClarificationAnswer[];
  answeredClarificationIds: string[];
  customReply: string;
};

export type NoteMsg = {
  id: string;
  role: "assistant";
  kind: "note";
  text: string;
  tone: "info" | "error" | "success";
};

export type ChatMessage = AdminMsg | ProposalMsg | NoteMsg;

export type AttachedFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  file: File;
};

export type ParseUploadUnit = {
  displayName: string;
  filename: string;
  mimeType: string;
  dataUrl: string;
  /** Original container name when several images came from one ZIP/folder. */
  sourceGroup?: string;
  /** Additional evidence sent in the same AI request (for example PDF text + rendered pages). */
  companions?: Array<{
    filename: string;
    mimeType: string;
    dataUrl: string;
  }>;
};

export type TabKey =
  | "assistant"
  | "trips"
  | "bot"
  | "leads"
  | "settings"
  | "analytics"
  | "flow"
  | "payments"
  | "greeting"
  | "seasons"
  | "photos"
  | "poster"
  | "documents"
  | "json";

export type FlowRule = {
  id: string;
  keywords: string;
  reply: string;
  buttons: string[];
};

export type LeadCrmStatus = "new_lead" | "contacted" | "booked" | "no_answer";

export type TravelLead = {
  id: number;
  kind: "handoff" | "booking";
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

export type CustomerDocumentStatus =
  | "needs_review"
  | "verified"
  | "wrong_extraction"
  | "duplicate"
  | "attached_to_booking"
  | "reviewed"
  | "ignored";

export type CustomerDocumentCategory =
  | "passport"
  | "travel_document"
  | "booking_code"
  | "trip_screenshot"
  | "payment_screenshot"
  | "other";

export type CustomerDocument = {
  id: number;
  platform: string;
  sender_id: string;
  page_id: string;
  source_url: string;
  stored_url: string;
  image_sha256: string;
  mime_type: string;
  category: CustomerDocumentCategory;
  extracted_json: Record<string, unknown>;
  matched_trip_id: string | null;
  matched_payment_id: number | null;
  duplicate_of_id: number | null;
  confidence: number;
  auto_action: string;
  status: CustomerDocumentStatus;
  created_at: string;
  updated_at: string;
  reviewed_at?: string | null;
  retention_hidden_at?: string | null;
};

export type DocumentSenderSummary = {
  sender_id: string;
  platform: string;
  display_name: string;
  total: number;
  needs_review: number;
  last_at: string;
  by_category: Record<CustomerDocumentCategory, number>;
};

export type DriveSyncRecentFile = {
  file_id: string;
  file_name: string;
  last_status: string;
  last_error: string;
  request_id: number | null;
  updated_at: string;
};

export type DriveSyncDiagnostics = {
  enabled: boolean;
  configured: boolean;
  folder_id: string | null;
  service_account_email: string | null;
  interval_minutes: number;
  file_limit: number;
  state: {
    status: "idle" | "running" | "success" | "warning" | "error";
    last_checked_at: string | null;
    last_synced_at: string | null;
    last_error: string;
    last_summary: string;
    last_run_id: string;
    files_examined: number;
    files_changed: number;
    files_applied: number;
    files_blocked: number;
    updated_at: string | null;
  };
  recent_files: DriveSyncRecentFile[];
};

export type ReadinessReport = {
  score: number;
  production: boolean;
  issues: Array<{
    key: string;
    severity: "critical" | "warning";
    message: string;
  }>;
};
