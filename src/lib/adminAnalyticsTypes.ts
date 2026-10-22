export const ANALYTICS_TIMEZONE = "Asia/Ulaanbaatar";
export type AnalyticsPeriod = 7 | 30;
export type AnalyticsStatsData = {
  totalLeads: number; newLeads: number; bookingLeads: number; totalContacts: number;
  leadsByDay: { date: string; count: number }[];
  leadsByTrip: { trip: string; count: number }[];
  leadsByStatus: Record<string, number>;
  leadsByKind: { kind: string; count: number }[];
  totalTrips: number; activeTrips: number;
  topTrips: { name: string; price: number; seats_left: number }[];
};
export type FaqStatsData = {
  week: { question: string; count: number }[];
  month: { question: string; count: number }[];
  allTime: { question: string; count: number }[];
  totalMessages: number;
};
export type ActivityStatsData = {
  periodDays: AnalyticsPeriod; inboundMessages: number; assistantMessages: number; activeConversations: number;
  daily: { date: string; inboundMessages: number; assistantMessages: number }[];
};
export type AttentionStatsData = {
  pendingHandoffs: number; oldestPendingHandoffAt: string | null; newBookingRequests: number;
  staffAlertsConfigured?: boolean;
  errors24h: number | null;
  recentIssues: { event: string; level: string; count: number; lastSeenAt: string }[];
  handoffReasons: { reason: string; count: number }[];
};
export type AnalyticsResponse = {
  ok: true; generatedAt: string; periodDays: AnalyticsPeriod; timezone: string;
  stats: AnalyticsStatsData; activity: ActivityStatsData | null;
  attention: AttentionStatsData | null; faq: FaqStatsData | null; warnings: string[];
};

export const ADMIN_ISSUE_LABELS: Record<string, string> = {
  "staff_alert.no_channel_configured": "Ажилтанд мэдэгдэх суваг тохируулаагүй",
  "staff_alert.all_channels_failed": "Ажилтанд мэдэгдэл хүрсэнгүй",
  "staff_alert.failed": "Ажилтны мэдэгдэл амжилтгүй",
  "webhook.ai_no_data_customer_silenced": "Баталгаагүй хариуг зогсоосон",
  "webhook.ai_incomplete_completion": "AI хариу дутуу ирсэн",
  "openai.incomplete_completion": "AI хариу дутуу ирсэн",
  "webhook.ai_outage_customer_silenced": "AI үйлчилгээ тасалдсан — ажилтанд шилжүүлсэн",
  "webhook.ai_refer_customer_silenced": "Дутуу мэдээлэлтэй асуултыг ажилтанд шилжүүлсэн",
  "webhook.ai_refer": "Асуултыг ажилтанд шилжүүлсэн",
};
