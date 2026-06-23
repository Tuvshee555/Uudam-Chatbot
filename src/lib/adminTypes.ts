/* ----------------------------------------------------------------
   Shared admin-panel types — extracted from src/pages/admin.tsx
   so that sub-files and utilities can import without a circular dep.
   ---------------------------------------------------------------- */

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
  updated_at: string;
};

export type PauseRow = {
  sender_id: string;
  paused_at: string;
  expires_at: string | null;
  reason?: string;
};

export type RecentRow = { sender_id: string; last_seen: string };

export type ControlState = {
  bot_paused: boolean;
  pause_reason: string | null;
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
  | "seasons";

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
