/**
 * Invented trips and a scripted model for the admin assistant's agent tests. No name, price,
 * date or photo here is a real trip. The model is a script of tool calls: each step sees the
 * messages so far and returns the calls the "model" makes (or throws, as a failing model does).
 */
import type { TravelTrip } from "../../src/lib/travelTypes";
import type { AgentDeps, ChatFn, ChatMessage, ToolDefinition } from "../../src/lib/assistantAgent/types";

// The clock sits in November so "12/2" rolls to this coming December.
export const NOW = new Date("2098-11-01T04:00:00Z");
export const VERSION = "2098-10-01T00:00:00Z";
export const CLOUD = "https://res.cloudinary.com/demo-cloud/image/upload/v1";

export function trip(fields: Partial<TravelTrip> & Pick<TravelTrip, "id" | "route_name">): TravelTrip {
  return {
    category: "", operator_name: "UUDAM TRAVEL AGENCY", duration_text: "4 өдөр 3 шөнө",
    adult_price: 2_590_000, child_price: 2_290_000, infant_price: 590_000, currency: "MNT",
    departure_dates: [], seats_total: null, seats_left: null, has_food: true, status: "active",
    notes: "", hotel: "", source_description: "", photo_urls: [], extra: {},
    created_at: VERSION, updated_at: VERSION, ...fields,
  };
}

const day = (n: number, title: string, photo?: string) => ({
  day: n, title, description: `${title}: туршилтын хөтөлбөрийн тайлбар.`, meals: { breakfast: true, lunch: null, dinner: false }, ...(photo ? { photo } : {}),
});

export const ALPHA = trip({
  id: "t-alpha", route_name: "ТУРШИЛТ – АЛЬФА ХОТЫН АЯЛАЛ",
  departure_dates: ["2098-12-02", "2098-12-09"],
  photo_urls: [`${CLOUD}/alpha-1.jpg`, `${CLOUD}/alpha-2.jpg`, `${CLOUD}/alpha-3.jpg`],
  extra: {
    aliases: ["Alfa", "Альфа"],
    website_slug: "alfa-hotyn-aylal",
    website_published: true,
    poster_trip_id: "poster-alpha",
    age_rules: { infant: "0-23 сар", child: "2-11 нас", adult: "12+ нас" },
    website_departure_availability: [
      { date: "2098-12-02", status: "OPEN", seatsLeft: 10 },
      { date: "2098-12-09", status: "OPEN", seatsLeft: 14 },
    ],
    price_groups: [
      { label: "12/2", dates: ["2098-12-02"], adult_price: 2_590_000, child_price: 2_290_000, infant_price: 590_000 },
      { label: "12/9", dates: ["2098-12-09"], adult_price: 2_590_000, child_price: 2_290_000, infant_price: 590_000 },
    ],
    itinerary_days: [
      day(1, "Улаанбаатар – Альфа хот", `${CLOUD}/alpha-day1.jpg`),
      day(2, "Альфа хотын аялал", `${CLOUD}/alpha-day2.jpg`),
      day(3, "Худалдааны өдөр", `${CLOUD}/alpha-day3.jpg`),
      day(4, "Буцах өдөр"),
    ],
  },
});

export const BETA = trip({
  id: "t-beta", route_name: "БЕТА НУУРЫН АЯЛАЛ",
  departure_dates: ["2098-12-02"],
  extra: { website_departure_availability: [{ date: "2098-12-02", status: "OPEN", seatsLeft: 6 }], itinerary_days: [day(1, "Нуурын өдөр"), day(2, "Буцах өдөр")] },
});

export const GAMMA = trip({
  id: "t-gamma", route_name: "ГАММА – ХАМТРАГЧИЙН АЯЛАЛ",
  departure_dates: ["2098-12-16"],
  photo_urls: [`${CLOUD}/gamma-1.jpg`],
  extra: {
    partner_sync: { source_url: "https://partner.example/tour/7" },
    website_departure_availability: [{ date: "2098-12-16", status: "OPEN", seatsLeft: 20 }],
    itinerary_days: [day(1, "Хамтрагчийн өдөр 1"), day(2, "Хамтрагчийн өдөр 2")],
  },
});

export const TRIPS = [ALPHA, BETA, GAMMA];

export type Call = { name: string; args: Record<string, unknown> };
export type Step = (input: { messages: ChatMessage[]; tools: ToolDefinition[] }) => Call[] | { content: string };

/** The tool results the model has seen so far, parsed (the last one last). */
export function toolResults(messages: ChatMessage[]): string[] {
  return messages.filter((message): message is Extract<ChatMessage, { role: "tool" }> => message.role === "tool").map((message) => message.content);
}

export function scriptedChat(steps: Step[]) {
  const inputs: Array<{ messages: ChatMessage[]; tools: string[]; timeoutMs: number; model: string }> = [];
  let index = 0;
  const chat: ChatFn = async (input) => {
    inputs.push({ messages: JSON.parse(JSON.stringify(input.messages)), tools: input.tools.map((tool) => tool.function.name), timeoutMs: input.timeoutMs, model: input.model });
    const step = steps[index];
    index += 1;
    if (!step) throw new Error(`the model was called ${index} times; the script has ${steps.length} steps`);
    const out = step({ messages: input.messages, tools: input.tools });
    const usage = { prompt_tokens: 1_000, completion_tokens: 50 };
    if (!Array.isArray(out)) return { message: { content: out.content }, usage };
    return {
      message: { content: null, tool_calls: out.map((call, n) => ({ id: `call_${index}_${n}`, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.args) } })) },
      usage,
    };
  };
  return { chat, inputs, get calls() { return index; } };
}

export function agentDeps(chat: ChatFn, overrides: Partial<AgentDeps> = {}): Partial<AgentDeps> {
  return {
    chat,
    safeFetch: async () => { throw new Error("no page fetch in this test"); },
    hostImage: async () => { throw new Error("no image hosting in this test"); },
    shortLinkLocation: async () => null,
    slugToTripId: async () => null,
    posterPhotos: async () => null,
    budget: async () => ({ exceeded: false, message: "" }),
    now: () => NOW.getTime(),
    ...overrides,
  };
}

export function htmlResponse(html: string, url = "https://partner.example/tour/42") {
  return { url, status: 200, contentType: "text/html; charset=utf-8", body: Buffer.from(html, "utf8") };
}
