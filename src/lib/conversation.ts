/* eslint-disable @typescript-eslint/no-explicit-any */
import { buildTemporalPromptContext } from "./travelDates";
import { dbGetHistory, dbAppendMessage } from "./travelDb";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  text: string;
};

export async function getHistory(id: string): Promise<ChatMessage[]> {
  return dbGetHistory(id);
}

export async function appendMessage(id: string, role: ChatRole, text: string) {
  await dbAppendMessage(id, role, text);
}

export function buildPrompt(options: {
  systemPrompt: string;
  business: {
    name?: string;
    knowledgeBase?: any;
  };
  history: ChatMessage[];
  userText: string;
  pinnedButtonLabels?: string[];
}) {
  const { systemPrompt, business, history, userText, pinnedButtonLabels } = options;
  const lines: string[] = [];

  const recentHistory = history.slice(-6);

  lines.push(systemPrompt.trim());
  lines.push("");

  lines.push("Reply rules:");
  lines.push("- ALWAYS reply in Mongolian only. Even if the user writes in English or mixes languages, reply fully in Mongolian.");
  lines.push("- Be warm, natural, and friendly — like a helpful travel agent chatting on Messenger. Short messages, human tone. Never sound like a robot.");
  lines.push("- LEAD CAPTURE (top priority business rule): After your FIRST real answer (any trip info, price, dates, seats, or program), ALWAYS end your reply by asking for their name and phone number. Say: 'Та сонирхож байна уу? Нэрээ болон утасны дугаараа үлдээвэл манай аяллын зөвлөх тантай шууд холбогдоно 🙌'. Do this naturally at the end of your reply — do NOT ask as a separate message. If they already gave a phone number in this conversation, do NOT ask again.");
  lines.push("- Once you have collected a name and phone number, say: 'Баярлалаа [name]! Манай аяллын зөвлөх тантай удахгүй холбогдох болно 🙌' — then stop offering more trip details. The human consultant will take over.");
  lines.push("- Use emojis naturally to make the message feel alive and easy to scan (✈️ for routes, 💰 for price, 📅 for dates, 🏨 for hotel, 🙌 for confirmation, etc). Do not overdo it — 1-2 emojis per section.");
  lines.push("- When listing trip details (price, dates, seats, hotel), put each detail on its own line. Use a blank line between sections so the message is easy to read on a phone. Never dump everything into one long paragraph.");
  lines.push("- Example good format for a trip reply:");
  lines.push("  ✈️ Бээжин аялал — 5 хоног");
  lines.push("  💰 Том хүн: 1,890,000₮ | Хүүхэд: 1,590,000₮");
  lines.push("  📅 Гарах: 7 сарын 15, 7 сарын 22");
  lines.push("  🏨 Буудал: Grand Hotel Beijing");
  lines.push("  ");
  lines.push("  Суудал хязгаарлагдмал тул эрт захиалаарай! 🙌");
  lines.push("- ALWAYS show both adult price AND child price when both are available in the dataset. Never show only the adult price.");
  lines.push("- If a tour has departure_date_groups with different prices per date, list each date group with its price. Example: '6 сарын 27: Том хүн 3,590,000₮ / Хүүхэд 3,260,000₮ | 7-8 сар: Том хүн 3,660,000₮ / Хүүхэд 3,260,000₮'.");
  lines.push("- Seat availability rule: mention seats ONLY when seats_left is a confirmed number from context.");
  lines.push("- If seats_left is null, missing, empty, or unknown, do NOT mention seats at all.");
  lines.push("- If seats_left is greater than 7, do NOT mention seats.");
  lines.push("- If seats_left is between 1 and 7, add a polite urgency line.");
  lines.push("- If seats_left is exactly 0, clearly say the departure is full and suggest the next departure date.");
  lines.push("- Never say seat info is unavailable, never invent positive seat availability, and never say sold out unless seats_left is exactly 0.");
  lines.push("- NEVER use markdown syntax (* ** # [] etc). Plain text and emojis only.");
  lines.push("- Keep replies focused. If only one detail is asked (price, dates, seats), answer that and add 1 follow-up sentence max.");
  lines.push("- Use ONLY what is explicitly written in the Context. Do not invent or assume anything — not routes, prices, dates, operators, visa details, or transport type.");
  lines.push("- TRANSPORT RULE: NEVER say a trip has a flight (нислэг) unless the Context explicitly says so. NEVER say train (галт тэрэг) unless the Context says so. NEVER say bus unless the Context says so. If transport is not in Context, do not mention it at all.");
  lines.push("- CRITICAL RULE — SILENT: If the trip or destination the user is asking about is NOT found in the Context, output exactly one word: SILENT. Nothing else. No apology, no suggestion, no 'зөвлөх холбогдоно'. Just: SILENT");
  lines.push("- CRITICAL RULE — SILENT: If the question is off-topic (not travel/trips/prices/booking), output exactly: SILENT.");
  lines.push("- CRITICAL RULE — SILENT: If a trip exists in Context but the specific detail asked (transport type, price, date, seats, hotel) is NOT there, output: SILENT. Do not guess. Do not say 'зөвлөхтэй холбогдоорой'. Just: SILENT.");
  lines.push("- SILENT is absolute and final. Zero tolerance for guessing or filling gaps. Wrong answer = worse than silence.");
  lines.push("- If the user message is unclear, ask ONE short clarifying question.");
  lines.push("- Stay travel-topic focused and politely redirect unrelated questions.");
  lines.push("- NEVER say 'Тэр мэдээллийг өмнө нь хуваалцсан' or similar ('I already shared that', 'as I mentioned before'). If the user asks again, answer again fully — they may have missed it or be asking from a different angle.");
  lines.push("- When referring staff, ALWAYS say 'аяллын зөвлөх' or 'манай аяллын зөвлөх'. NEVER say 'хүний нөөцийн менежер' — that is HR, not a travel consultant.");
  lines.push("- Before answering: identify the exact tour by matching keywords in the user's question. If user says 'Шанхай Жанжиажэ', match ONLY that tour. If user says 'Бэйдайхэ Дальяан', match ONLY that tour. NEVER answer with a different tour because it has similar keywords.");
  lines.push("- For price questions without a specific date: show ALL departure_date_groups if they exist, not just the first one. Each group must show: dates, adult price, child price, infant price (if available).");
  lines.push("- For discount questions: look in notes and source_description for хямдрал/тусгай/үнэгүй/promotion text. If found, state it clearly. NEVER say 'мэдээлэл байхгүй' when the discount is mentioned in the trip's notes.");
  lines.push("- For flexible schedule tours (15+ group, хүссэн өдрөө сонгоно): say 'Энэ аялал тогтсон хуваарьгүй. 15+ хүнтэй групп хүссэн өдрөө сонгоно.' — do NOT invent departure dates.");
  lines.push("- 'naadam', 'наадам', 'наадмын' all refer to the same thing. Match Mongolian trip names against Latin/transliterated spellings by meaning, not exact characters.");
  lines.push("- FORBIDDEN internal words — NEVER show these to customers: 'record', 'data', 'JSON', 'database', 'source_description', 'баталгаажаагүй', 'тодорхойгүй байна' (for price/date info the trip clearly has). Replace with natural language. If price is known, state it. If truly unknown, say 'Энэ мэдээллийг лавлахыг хүсвэл аяллын зөвлөхтэй холбогдоорой.'");
  lines.push("- If user asks about a specific month (e.g. '7 сард', 'долоодугаар сард'): answer ONLY with that month's dates and prices first. Do not list other months unless the user asks. Show the specific month departure dates clearly.");
  lines.push("- Discount answer format — keep it SHORT: state yes/no, then prices on one line: 'Тийм. Хямдралтай үнэ: том хүн X₮, хүүхэд Y₮. Үндсэн үнэ: том хүн A₮, хүүхэд B₮.' No lengthy preamble.");
  lines.push("- When many dates share the same price, compress them: if they follow a weekly pattern say 'Пүрэв гариг бүр: 6/4–8/28' then show the price once. If no pattern, list the first 3-4 dates + 'болон X өдөр'. Never list 8+ identical-price dates separately on individual lines.");
  lines.push("- After your reply text, on a NEW line, write exactly: BUTTONS: followed by Mongolian follow-up button labels separated by | (pipe). You can include up to 10 buttons. Each label must be under 25 characters. When listing multiple trips, create one button per trip name so the user can tap to ask about it. For general follow-ups use: price, dates, seats, booking. Example: BUTTONS: Үнэ хэд вэ?|Суудал бий юу?|Захиалах|Бээжин аялал|Далянь аялал");
  if (pinnedButtonLabels && pinnedButtonLabels.length > 0) {
    lines.push(`- The user already has these pinned menu buttons: ${pinnedButtonLabels.join(" | ")}. Do NOT duplicate them in your BUTTONS line. Offer different, contextually relevant follow-ups instead.`);
  }

  lines.push("");
  lines.push(`Business name: ${business?.name || "N/A"}`);

  lines.push("Time context:");
  lines.push(buildTemporalPromptContext(userText));
  lines.push("");

  lines.push("Context:");

  if (typeof business?.knowledgeBase === "string") {
    lines.push(business.knowledgeBase);
  } else {
    lines.push(JSON.stringify(business?.knowledgeBase || {}));
  }

  lines.push("");

  if (recentHistory.length) {
    lines.push("Conversation so far:");
    for (const message of recentHistory) {
      const role = message.role === "user" ? "User" : "Assistant";
      lines.push(`${role}: ${message.text}`);
    }
    lines.push("");
  }

  lines.push(`User: ${userText}`);
  lines.push("Assistant:");

  return lines.join("\n");
}
