import type { FlowRule } from "@/lib/adminTypes";

export type AnalyticsStatsData = {
  totalLeads: number;
  newLeads: number;
  bookingLeads: number;
  leadsByDay: { date: string; count: number }[];
  leadsByTrip: { trip: string; count: number }[];
  leadsByStatus: Record<string, number>;
  totalTrips: number;
  activeTrips: number;
  totalContacts: number;
  topTrips: { name: string; price: number; seats_left: number }[];
};

type TopQuestion = { question: string; count: number };
export type FaqStatsData = {
  week: TopQuestion[];
  month: TopQuestion[];
  allTime: TopQuestion[];
  totalMessages: number;
};

export type SeasonItem = {
  id: string;
  name: string;
  keywords: string[];
  photoUrls: string[];
  active: boolean;
};

export function readUrlList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((url): url is string => typeof url === "string" && url.startsWith("https://"))
    : [];
}

export function readSeasons(extra: Record<string, unknown>): SeasonItem[] {
  const raw = extra.seasons;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((season): season is Record<string, unknown> => Boolean(season) && typeof season === "object")
    .map((season) => ({
      id: typeof season.id === "string" ? season.id : Math.random().toString(36).slice(2),
      name: typeof season.name === "string" ? season.name : "",
      keywords: Array.isArray(season.keywords)
        ? season.keywords.filter((keyword): keyword is string => typeof keyword === "string")
        : [],
      photoUrls: readUrlList(season.photoUrls),
      active: season.active === true,
    }));
}

export type GreetingDraft = {
  enabled: boolean;
  text: string;
  photoUrls: string[];
  usePhotoUrls: boolean;
  defaultPhotoUrls: string[];
};

export function readGreetingDraft(extra: Record<string, unknown>): GreetingDraft {
  const raw =
    extra && typeof extra.greeting === "object" && extra.greeting !== null
      ? (extra.greeting as Record<string, unknown>)
      : {};
  return {
    enabled: raw.enabled !== false,
    text: typeof raw.text === "string" ? raw.text : "",
    photoUrls: readUrlList(raw.photoUrls),
    usePhotoUrls: raw.usePhotoUrls === true,
    defaultPhotoUrls: readUrlList(raw.defaultPhotoUrls),
  };
}

export type PaymentRow = {
  id: number;
  invoice_id: string;
  platform: string;
  sender_id: string;
  customer_name: string;
  trip_name: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "expired" | "cancelled";
  note: string;
  created_at: string;
  paid_at: string | null;
};

export type PaymentStats = { total: number; paid: number; pending: number; paidAmount: number };

export const PAYMENT_STATUS_MN: Record<PaymentRow["status"], string> = {
  pending: "Хүлээгдэж буй",
  paid: "Төлсөн",
  expired: "Хугацаа дууссан",
  cancelled: "Цуцалсан",
};

export const PAYMENT_STATUS_TONE: Record<
  PaymentRow["status"],
  "neutral" | "warning" | "success" | "danger"
> = {
  pending: "warning",
  paid: "success",
  expired: "neutral",
  cancelled: "danger",
};

export const BLANK_FLOW_RULE: Omit<FlowRule, "id"> = {
  keywords: "",
  reply: "",
  buttons: [],
};
