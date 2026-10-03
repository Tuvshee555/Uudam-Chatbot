import { sanitizeAssistantReply, stripRepeatedGreeting } from "./reply";
import type { PassengerKind } from "./tripOffers";

export const CHATBOT_REPLY_RULES = [
  "Answer the customer's current question first. Be polite and natural, without empty enthusiasm or repeating the question.",
  "For one fact, normally use 1-3 short lines. For multiple questions, answer every requested part in a compact list. Essential fare conditions must never be omitted to meet a length budget.",
  "Show only the requested passenger fare when they specify adult, child or infant. Do not add unrelated dates, visas, hotels or itineraries.",
  "Ask at most one necessary clarification at a time. Use the known trip/date/hotel/passengers; never ask again for information already provided.",
  "Offer at most three options initially, and say more options exist when relevant. Show the full list when explicitly requested.",
  "A program request normally gets a short summary or the published trip link. Give the full day-by-day program only when explicitly requested. Send photos or files only when requested.",
  "Use zero or one relevant emoji, not emoji headings on every line. Do not repeat greetings or pressure customers for contact information.",
  "If the customer asks again, answer again. Never scold them or replace the answer with 'already answered'.",
  "Never promise a reservation, refund, staff callback or completed handoff unless the application has actually confirmed that action. Keep each customer's private information separate.",
] as const;

export function replyPreferences(text: string) {
  const full = /бүх|бүгд|дэлгэрэнгүй|бүтэн|нэг\s*бүр|өдөр\s*бүр|all\b|full\b|detailed|every\s*day|bugd|delgerengui|buten/i.test(text);
  const fareKinds: PassengerKind[] = [];
  if (/том\s*хүн|насанд\s*хүрэгч|adult|tom\s*hun/i.test(text)) fareKinds.push("adult");
  if (/хүүх(?:эд|дийн)|child|huuhed|huuhdiin/i.test(text)) fareKinds.push("child");
  if (/нярай|infant|nyarai/i.test(text)) fareKinds.push("infant");
  const terms = [
    ["deposit", /урьдчилгаа|deposit|uridchilgaa/i],
    ["payment", /төлбөр|төлөх|payment|pay\b|tulbur/i],
    ["documents", /паспорт|бичиг\s*баримт|passport|document/i],
    ["visa", /виз|visa/i],
    ["cancellation", /цуцл|буцаалт|cancel|refund/i],
  ] as const;
  const includes = [
    { label: "Хоол", pattern: /хоол|food|meal|hool/i },
    { label: "Тийз", pattern: /тийз|тасалбар|ticket|tiiz|tiz/i },
    { label: "Буудал", pattern: /буудал|hotel|buudal/i },
    { label: "Даатгал", pattern: /даатгал|insurance|daatgal/i },
    { label: "Виз", pattern: /виз|visa/i },
    { label: "Унаа", pattern: /унаа|transfer|тээвэр|transport|unaa/i },
  ].filter((target) => target.pattern.test(text));
  return { full, optionLimit: full ? Infinity : 3, fareKinds: full ? [] : fareKinds,
    termKeys: full ? [] : terms.filter(([, pattern]) => pattern.test(text)).map(([key]) => key),
    includes: full ? [] : includes };
}

export function compactReplyOptions(options: string[], text: string): string[] {
  const limit = replyPreferences(text).optionLimit;
  const unique = [...new Set(options)];
  return [...unique.slice(0, limit), ...(unique.length > limit ? [`Өөр ${unique.length - limit} сонголт бий. Бүх сонголтыг хүсвэл хэлээрэй.`] : [])];
}

// Only independent labelled fare lines are removed. Never truncate arbitrary
// paragraphs, passenger totals, ranges, or the conditions attached to an offer.
export function presentAssistantReply(input: {
  reply: string; userText: string; hasPriorReply?: boolean; phoneAlreadyRequested?: boolean;
}): string {
  if (/^(?:REFER|SILENT)$/i.test(input.reply.trim())) return input.reply.trim();
  const preferences = replyPreferences(input.userText);
  let reply = stripRepeatedGreeting(sanitizeAssistantReply(input.reply), Boolean(input.hasPriorReply));
  if (preferences.fareKinds.length) {
    const lines = reply.split("\n");
    const labels: Array<[PassengerKind, RegExp]> = [
      ["adult", /том\s*хүн|насанд\s*хүрэгч|adult/i],
      ["child", /хүүх(?:эд|дийн)|child/i], ["infant", /нярай|infant/i],
    ];
    const canFocus = !/нийт\s*:|total\s*:|\bx\s*\d|×\s*\d/i.test(reply) && lines.some((line) =>
      labels.some(([kind, pattern]) => preferences.fareKinds.includes(kind) && pattern.test(line) && /₮|MNT|үнэгүй|free/i.test(line)));
    if (canFocus) reply = lines.filter((line) => {
      const kinds = labels.filter(([, pattern]) => pattern.test(line)).map(([kind]) => kind);
      const standalone = /^\s*(?:[•*-]\s*)?(?:том\s*хүн|насанд\s*хүрэгч|adult|хүүх(?:эд|дийн)|child|нярай|infant)/i.test(line)
        && /[:：]/.test(line) && /₮|MNT|үнэгүй|free/i.test(line);
      return !standalone || kinds.length !== 1 || preferences.fareKinds.includes(kinds[0]);
    }).join("\n");
  }
  const wantsContact = /захиал|залга|холбо|зөвлөх|оператор|book\b|booking|call\b|consultant|human|zahial|holbo/i.test(input.userText);
  if (input.phoneAlreadyRequested || !wantsContact) {
    const lines = reply.split("\n");
    const filtered = lines.filter((line) => !/^\s*(?:утасны\s+дугаараа|дугаараа\s+үлдээ|please\s+(?:leave|share)\s+your\s+phone)/i.test(line));
    if (filtered.some((line) => line.trim())) reply = filtered.join("\n");
  }
  let emojis = 0;
  reply = reply.replace(/https?:\/\/\S+|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu,
    (value) => value.startsWith("http") || ++emojis <= 1 ? value : "");
  return reply.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
