/* eslint-disable @typescript-eslint/no-explicit-any */
import { getEnv } from "./env";
import { recordCounter } from "./observability";
import { withRedis } from "./redisState";
import { buildTemporalPromptContext } from "./travelDates";

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  text: string;
};

type ChatSession = {
  messages: ChatMessage[];
  updatedAt: number;
};

const STORE = new Map<string, ChatSession>();
const env = getEnv();
const MAX_MESSAGES = 12;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = env.conversationMaxSessions;
const CONVERSATION_INDEX_KEY = "conversation:index";

function conversationListKey(id: string) {
  return `conversation:messages:${id}`;
}

function prune() {
  const now = Date.now();
  for (const [key, session] of STORE.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) STORE.delete(key);
  }

  const overflow = STORE.size - MAX_SESSIONS;
  if (overflow <= 0) return;

  const oldest = Array.from(STORE.entries())
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .slice(0, overflow);
  for (const [key] of oldest) {
    STORE.delete(key);
  }
}

export async function getHistory(id: string): Promise<ChatMessage[]> {
  if (env.redisConversationEnabled) {
    const redisHistory = await withRedis("conversation.get_history", async (redis) => {
      const raw = await redis.lrange(conversationListKey(id), -MAX_MESSAGES, -1);
      if (!raw.length) {
        await redis.zrem(CONVERSATION_INDEX_KEY, id);
        return [] as ChatMessage[];
      }
      const parsed: ChatMessage[] = [];
      for (const entry of raw) {
        try {
          const message = JSON.parse(entry) as ChatMessage;
          if (
            (message.role === "user" || message.role === "assistant") &&
            typeof message.text === "string"
          ) {
            parsed.push(message);
          }
        } catch {
          // Drop malformed entries to prevent runtime crashes.
        }
      }
      return parsed;
    });

    if (redisHistory) return redisHistory;
    recordCounter("conversation.redis_fallback_total", 1, {
      operation: "getHistory",
    });
  }

  prune();
  return STORE.get(id)?.messages || [];
}

export async function appendMessage(id: string, role: ChatRole, text: string) {
  if (env.redisConversationEnabled) {
    const redisApplied = await withRedis("conversation.append_message", async (redis) => {
      const now = Date.now();
      const key = conversationListKey(id);
      const payload = JSON.stringify({ role, text });
      const pipeline = redis.pipeline();
      pipeline.rpush(key, payload);
      pipeline.ltrim(key, -MAX_MESSAGES, -1);
      pipeline.pexpire(key, SESSION_TTL_MS);
      pipeline.zadd(CONVERSATION_INDEX_KEY, now, id);
      const execResult = await pipeline.exec();
      if (!execResult) return false;

      const total = await redis.zcard(CONVERSATION_INDEX_KEY);
      if (total > MAX_SESSIONS) {
        const overflow = total - MAX_SESSIONS;
        const oldest = await redis.zrange(CONVERSATION_INDEX_KEY, 0, overflow - 1);
        if (oldest.length) {
          const eviction = redis.pipeline();
          for (const sessionId of oldest) {
            eviction.zrem(CONVERSATION_INDEX_KEY, sessionId);
            eviction.del(conversationListKey(sessionId));
          }
          await eviction.exec();
        }
      }
      return true;
    });

    if (redisApplied) return;
    recordCounter("conversation.redis_fallback_total", 1, {
      operation: "appendMessage",
    });
  }

  prune();
  const session = STORE.get(id) || { messages: [], updatedAt: Date.now() };
  session.messages.push({ role, text });

  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }

  session.updatedAt = Date.now();
  STORE.set(id, session);
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
  lines.push("- Be warm, natural, and friendly — like a helpful travel agent chatting on Messenger.");
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
  lines.push("- If seats_left and seats_total are BOTH null/missing, say 'суудлын мэдээлэл одоогоор байхгүй' — do NOT say 'суудал байхгүй' or imply the tour is sold out.");
  lines.push("- NEVER use markdown syntax (* ** # [] etc). Plain text and emojis only.");
  lines.push("- Keep replies focused. If only one detail is asked (price, dates, seats), answer that and add 1 follow-up sentence max.");
  lines.push("- Use only the provided context. Do not invent routes, prices, departure dates, operators, or visa details.");
  lines.push("- Resolve relative date words using the Time context. Do not ask what date 'маргааш', 'margaash', or 'tomorrow' means.");
  lines.push("- If the user asks whether a trip departs on a resolved date, answer yes/no from departure dates in Context. If no exact match exists, say no and optionally mention nearby listed dates.");
  lines.push("- If the user asks for exact үнэ/өдөр, quote it from the dataset as-is.");
  lines.push("- If the same route has different prices between operators, mention that operator prices differ and ask which operator they want.");
  lines.push("- If information is missing or ambiguous, clearly say it is not confirmed in the current dataset.");
  lines.push("- If the user message is unclear, ask ONE short clarifying question.");
  lines.push("- Stay travel-topic focused and politely redirect unrelated questions.");
  lines.push("- After your reply text, on a NEW line, write exactly: BUTTONS: followed by 2-3 short Mongolian follow-up button labels separated by | (pipe). Each label must be under 40 characters. Choose buttons that naturally continue the conversation (e.g. ask for price, seats, booking, nearby dates). Example: BUTTONS: Үнэ хэд вэ?|Суудал бий юу?|Захиалах");
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
