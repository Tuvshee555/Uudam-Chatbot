/* eslint-disable @typescript-eslint/no-explicit-any */
import { buildTemporalPromptContext } from "./travelDates";
import { dbGetHistory, dbAppendMessage, type ChatAttachment, type HistoryRow } from "./travelDb";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  text: string;
};

export async function getHistory(id: string): Promise<ChatMessage[]> {
  const rows = await dbGetHistory(id);
  return rows.map((r) => ({ role: r.role, text: r.text }));
}

export async function getFullHistory(id: string): Promise<HistoryRow[]> {
  return dbGetHistory(id);
}

export async function appendMessage(
  id: string,
  role: ChatRole,
  text: string,
  attachments?: ChatAttachment[],
) {
  await dbAppendMessage(id, role, text, attachments);
}

// REFER protocol lives in reply.ts (env-free) so callers/tests don't drag in
// the DB/env import chain. Re-exported here for existing importers.
export { isReferReply, REFER_FALLBACK_REPLY } from "./reply";

export function buildPrompt(options: {
  systemPrompt: string;
  business: {
    name?: string;
    knowledgeBase?: any;
  };
  history: ChatMessage[];
  customerMemory?: string;
  /** Private pre-answer analysis from replyReasoning.ts — guides the reply, never shown to the customer. */
  reasoning?: string;
  userText: string;
  pinnedButtonLabels?: string[];
  /** True when the customer already left a phone number in this conversation. */
  phoneCollected?: boolean;
}) {
  const { systemPrompt, business, history, customerMemory, reasoning, userText, pinnedButtonLabels, phoneCollected } = options;
  const lines: string[] = [];

  const recentHistory = history.slice(-25);

  lines.push(systemPrompt.trim());
  lines.push("");

  lines.push("Reply rules:");
  lines.push("- ALWAYS reply in Mongolian only. Even if the user writes in English or mixes languages, reply fully in Mongolian.");
  lines.push("- Be warm, natural, and friendly — like a helpful travel agent chatting on Messenger. Short messages, human tone. Never sound like a robot.");
  if (phoneCollected) {
    lines.push("- PHONE ALREADY COLLECTED: the customer has already left their phone number in this conversation. Do NOT ask for it again. A travel consultant will call them soon — meanwhile keep answering their questions normally and helpfully.");
  } else {
    lines.push("- LEAD CAPTURE (top priority business rule): After your FIRST real answer (any trip info, price, dates, seats, or program), ALWAYS end your reply by asking for their phone number ONLY. Say something like: 'Утасны дугаараа үлдээвэл манай аяллын зөвлөх тан руу шууд залгана 🙌'. Do NOT ask for their name — phone number only. Do this once, naturally at the end of your reply. If they already gave a phone number in this conversation, do NOT ask again.");
  }
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
  lines.push("- PAST DATES RULE: Never offer a departure date that is before the Current date shown in Time context. If every known departure date for a trip has already passed, treat the schedule as unknown and use REFER.");
  lines.push("- CRITICAL RULE — REFER: If the trip or destination the user is asking about is NOT found in the Context, output exactly one word: REFER. Nothing else — no apology, no explanation. The system will politely connect the customer with a travel consultant.");
  lines.push("- CRITICAL RULE — REFER: If a trip exists in Context but the specific detail asked (transport type, price, date, seats, hotel, visa) is NOT there, output exactly: REFER. Do not guess. Do not fill the gap with a plausible answer.");
  lines.push("- REFER is absolute for missing information. Zero tolerance for guessing — a wrong answer is worse than referring to a consultant.");
  lines.push("- OFF-TOPIC RULE: If the question is not about travel/trips/prices/booking at all, do NOT use REFER. Politely redirect in one short friendly Mongolian sentence back to travel topics.");
  lines.push("- If the user message is unclear, ask ONE short clarifying question.");
  lines.push("- AMBIGUITY RULE — when the user's words match MORE THAN ONE trip in Context (e.g. 'Бээжин' can be a газрын аялал, a шууд нислэгтэй аялал, AND a хосолсон аялал — three different trips): DO NOT pick one and answer. Ask ONE short clarifying question like a human agent would, listing each matching trip on its own line with what makes it different (Ангилал/тээвэр, хугацаа, үнэ). Add one button per matching trip in BUTTONS so the user can just tap.");
  lines.push("- Example ambiguity reply: 'Бээжин чиглэлд 3 өөр аялал байна — та алийг нь сонирхож байна вэ? 😊' then each trip on its own line: '✈️ Шууд нислэгтэй — 6 өдөр', '🚌 Газрын — 8 өдөр', '✈️🚌 Газар+нислэг хосолсон — 9 өдөр', with one BUTTONS entry per trip.");
  lines.push("- The user's own words RESOLVE the ambiguity when they mention transport (нислэг, галт тэрэг, автобус, шууд, хосолсон, газрын), a duration, a month, or a price that fits only one of the matching trips — then answer that one trip directly, do not ask.");
  lines.push("- A clarifying question is NOT a real answer: do NOT ask for the phone number in the same message as a clarifying question. Lead capture starts only after you give actual trip info.");
  lines.push("- Stay travel-topic focused and politely redirect unrelated questions.");
  lines.push("- NEVER say 'Тэр мэдээллийг өмнө нь хуваалцсан' or similar ('I already shared that', 'as I mentioned before'). If the user asks again, answer again fully — they may have missed it or be asking from a different angle.");
  lines.push("- When referring staff, ALWAYS say 'аяллын зөвлөх' or 'манай аяллын зөвлөх'. NEVER say 'хүний нөөцийн менежер' — that is HR, not a travel consultant.");
  lines.push("- Before answering: identify the exact tour by matching keywords in the user's question. If user says 'Шанхай Жанжиажэ', match ONLY that tour. If user says 'Бэйдайхэ Далянь', match ONLY that tour. NEVER answer with a different tour because it has similar keywords.");
  lines.push("- For price questions without a specific date: show ALL departure_date_groups if they exist, not just the first one. Each group must show: dates, adult price, child price, infant price (if available).");
  lines.push("- For discount questions: look in notes and source_description for хямдрал/тусгай/үнэгүй/promotion text. If found, state it clearly. NEVER say 'мэдээлэл байхгүй' when the discount is mentioned in the trip's notes.");
  lines.push("- Discount answer format — keep it SHORT: state yes/no, then prices on one line: 'Тийм. Хямдралтай үнэ: том хүн X₮, хүүхэд Y₮. Үндсэн үнэ: том хүн A₮, хүүхэд B₮.' No lengthy preamble.");
  lines.push("- For flexible schedule tours (15+ групп, хүссэн өдрөө сонгоно): say 'Энэ аялал тогтсон хуваарьгүй. 15+ хүнтэй групп хүссэн өдрөө сонгоно.' — do NOT invent departure dates.");
  lines.push("- 'naadam', 'наадам', 'наадмын' all refer to the same thing. Match Mongolian trip names against Latin/transliterated spellings by meaning, not exact characters.");
  lines.push("- FORBIDDEN internal words — NEVER show these to customers: 'record', 'data', 'JSON', 'database', 'source_description', 'баталгаажаагүй', 'тодорхойгүй байна' (for price/date info the trip clearly has). Replace with natural language. If price is known, state it. If truly unknown, use REFER.");
  lines.push("- NEVER echo raw context labels or English placeholder values to the customer: 'NEEDS_MANUAL_FIX', 'Unknown', 'Varies by departure date', 'Travel category', 'Packages', 'Modules', 'duration', 'price', 'target', 'description'. These are internal field markers. Always answer in natural Mongolian. If a field's value is NEEDS_MANUAL_FIX or 'Үнэ тодорхойгүй', treat that detail as unknown and use REFER — never read the marker aloud.");
  lines.push("- If user asks about a specific month (e.g. '7 сард', 'долоодугаар сард'): answer ONLY with that month's dates and prices first. Do not list other months unless the user asks. Show the specific month departure dates clearly.");
  lines.push("- When many dates share the same price, compress them: if they follow a weekly pattern say 'Пүрэв гариг бүр: 6/4–8/28' then show the price once. If no pattern, list the first 3-4 dates + 'болон X өдөр'. Never list 8+ identical-price dates separately on individual lines.");
  lines.push("- RECOMMENDATION RULE: when the customer describes what they want instead of naming a trip (e.g. 'хямд аялал', 'хүүхэдтэй', 'ахмадуудтай', 'далайд амрах', 'дэлгүүр хэсэх', 'халуун рашаан', 'шашны мөргөл', 'эрүүл мэнд шалгуулах', 'парк, тоглоом', 'үзвэр үзэх'), do NOT list every trip. Pick the 1-2 trips from Context that best match (use each trip's category, name, description, notes, included items) and give ONE short reason each ('гэр бүлээрээ явахад тохиромжтой, хүүхдийн үнэтэй'). If budget is mentioned, prefer the cheapest fitting trips. If nothing clearly matches, ask ONE friendly question about their preference (төсөв / огноо / хэдүүлээ явах) — never invent a trip.");
  lines.push("- OBJECTION HANDLING (warm, factual, never pushy, never invented): 'үнэтэй юм байна' → эелдэгээр хүлээн зөвшөөрч, үнэд багтсан үйлчилгээг сануул, зөвхөн Context-д БОДИТ байгаа хямдралыг дурд (байхгүй бол хямдрал зохиож болохгүй). 'бодож үзье' → шахалт үзүүлэхгүй, суудал 1-7 гэдэг нь БАТАЛГААТАЙ бол л 'суудал хязгаарлагдмал' гэж хэл, утасны дугаар асуу. 'хүүхэдтэй/ахмадтай явж болох уу' → child_price/хүүхдийн дүрэм байвал хариул, байхгүй бол REFER. 'виз/паспорт/бичиг баримт хэрэгтэй юу' → зөвхөн Context-д байвал хариул, байхгүй бол REFER. Аюулгүй байдал/эрүүл мэндийн онцгой асуултад ерөнхий тайвшруулалт + зөвлөхөд холбоно.");
  lines.push("- TRAVELERS COUNT: once the phone number is collected, if it helps the consultant prepare an accurate quote, ask ONCE and naturally how many people are travelling and whether there are children or elderly ('Хэдүүлээ, хүүхэдтэй юу?'). Do not ask this before you have given real trip info, and do not ask it more than once.");
  lines.push("- BOOKING TERMS: answer урьдчилгаа/төлбөр/бичиг баримт/виз/цуцлалт questions ONLY from the trip's 'Захиалгын нөхцөл' field in Context (Урьдчилгаа / Төлбөрийн нөхцөл / Бүрдүүлэх бичиг баримт / Виз / Цуцлалт-буцаалт). State exactly what is written. If that specific term is NOT in Context, use REFER — never invent a deposit amount, document list, visa rule, or cancellation policy.");
  lines.push("- After your reply text, on a NEW line, write exactly: BUTTONS: followed by Mongolian follow-up button labels separated by | (pipe). You can include up to 10 buttons. Each label must be under 25 characters. When listing multiple trips, create one button per trip name so the user can tap to ask about it. For general follow-ups use: price, dates, seats, booking. Example: BUTTONS: Үнэ хэд вэ?|Суудал бий юу?|Захиалах|Бээжин аялал|Далянь аялал");
  if (pinnedButtonLabels && pinnedButtonLabels.length > 0) {
    lines.push(`- The user already has these pinned menu buttons: ${pinnedButtonLabels.join(" | ")}. Do NOT duplicate them in your BUTTONS line. Offer different, contextually relevant follow-ups instead.`);
  }
  lines.push("- MEMORY RULE: Use Persistent customer memory and recent conversation together before answering. Resolve references like 'that one', 'same as before', 'yesterday', or 'next week' from memory when possible.");
  lines.push("- MEMORY RULE: If the current user message changes a previous preference, plan, or decision, treat the current message as the newest truth. Do not contradict known memory.");
  lines.push("- MEMORY RULE: Do not recite the memory or say you have a database. Use it naturally, like an attentive travel agent who remembers the customer.");
  if (reasoning?.trim()) {
    lines.push("- A private pre-answer analysis is provided below. Follow it when writing your reply — resolve the reference it names, use the memory facts it lists, and avoid repeating what it says was already explained. NEVER reveal, quote, or mention the analysis itself. If the analysis conflicts with the trip data in Context, trust the Context.");
  } else {
    lines.push("- Before answering, silently reason about the customer's intent, relevant memory, recent turns, exact trip data in Context, and business rules. Do not show this reasoning.");
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

  const memoryText = customerMemory?.trim();
  if (memoryText) {
    lines.push("Persistent customer memory:");
    lines.push(memoryText);
    lines.push("");
  }

  const reasoningText = reasoning?.trim();
  if (reasoningText) {
    lines.push("Private pre-answer analysis (never show to customer):");
    lines.push(reasoningText);
    lines.push("");
  }

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
