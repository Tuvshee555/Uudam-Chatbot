import { sanitizeAssistantReply, stripRepeatedGreeting } from "./reply";
import type { PassengerKind } from "./tripOffers";

export const CHATBOT_REPLY_RULES = [
  "Answer directly, like a brief human message. Prefer labels and facts over complete sentences. No introduction, sales pitch, repeated question, repeated trip name, or closing offer to help.",
  "For one fact, aim for about 10 words on one line. Use extra lines only for requested facts or necessary fare qualifications. No paragraphs or unsolicited trip overview. Essential fare conditions must never be omitted to meet a length budget.",
  "Show only the requested passenger fare when they specify adult, child or infant. Do not add unrelated dates, visas, hotels or itineraries.",
  "Ask at most one necessary clarification at a time, using a few words. Ask only when the missing detail blocks the answer; otherwise answer and stop. Use the known trip/date/hotel/passengers; never ask again for information already provided.",
  "Offer at most three options initially, and say more options exist when relevant. Show the full list when explicitly requested.",
  "A program request normally gets a short summary or the published trip link. Give the full day-by-day program only when explicitly requested. Send photos or files only when requested.",
  "Prefer no emoji; use at most one when useful. Do not add greetings to factual answers, ask if more help is needed, or pressure customers for contact information. 'I will think about it' needs no sales pitch or phone request.",
  "If the customer asks again, answer again. Never scold them or replace the answer with 'already answered'.",
  "Never promise a reservation, refund, staff callback or completed handoff unless the application has actually confirmed that action. Keep each customer's private information separate.",
] as const;

export function replyPreferences(text: string) {
  const full = /(?:^|[^\p{L}])(?:бүх|бүгд\p{L}*|дэлгэрэнгүй|бүтэн|нэг\s*бүр|all|full|detailed|bugd\p{L}*|delgerengui|buten)(?=$|[^\p{L}])/iu.test(text)
    || /(?:өдөр\s*бүр(?:ийн)?|every\s*day|day.by.day).{0,15}(?:хөтөлбөр|itinerary|program)|(?:хөтөлбөр\p{L}*|itinerary|program).{0,15}(?:өдөр\s*бүр|every\s*day|day.by.day)/iu.test(text);
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
  const termKeys = terms.filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
  // Detail changes what is displayed, never which requested facts need support.
  return { full, optionLimit: full ? Infinity : 3, fareKinds: full ? [] : fareKinds,
    termKeys: full ? [] : termKeys, includes: full ? [] : includes,
    requiredFareKinds: fareKinds, requiredTermKeys: termKeys, requiredIncludes: includes };
}

export function compactReplyOptions(options: string[], text: string): string[] {
  const limit = replyPreferences(text).optionLimit;
  const unique = [...new Set(options)];
  return [...unique.slice(0, limit), ...(unique.length > limit ? [`Өөр ${unique.length - limit} сонголт бий.`] : [])];
}

// Remove only recognizable conversational padding, never arbitrary words or
// factual sentences. Protect URLs before sentence cleanup (including signed URLs).
function removeReplyPadding(text: string, allowContact: boolean): string {
  const urls: string[] = [];
  let prefix = "COMPACTREPLYURL";
  while (text.includes(prefix)) prefix += "X";
  let reply = text.replace(/https?:\/\/[^\s<>]+/g, url => `${prefix}${urls.push(url) - 1}END`);
  reply = reply
    .replace(/(?:^|\n)\s*(?:Сайн\s+байна\s+уу|Сайн\s+уу|Hello|Hi)(?=$|[\s!,.😊])[!,.\s]*(?:😊\s*)?/giu, "\n")
    .replace(/(?:^|\n)\s*(?:Би\s+танд\s+туслахад\s+бэлэн\s+байна|Мэдээллийг\s+хүргэж\s+байна|Here\s+(?:is|are)\s+the\s+(?:information|details))\s*[.!:]?\s*/giu, "\n")
    .replace(/(?:^|\n)\s*Та\s+[^\n?\d₮]*?(?:талаар\s+)?(?:дэлгэрэнгүй\s+)?мэдээлэл\s+авахыг\s+хүсэж\s+байна\s+уу\?\s*/giu, "\n")
    .replace(/(?:^|[.!?]\s+|\n)(?:Өөр\s+(?:асуулт|мэдээлэл)[^\n.!?]*?(?:байвал\s+хэлээрэй|хэрэгтэй\s+юу|байна\s+уу)|Let\s+me\s+know\s+if\s+you\s+(?:need|have)[^\n.!?]*)[.!?]?\s*$/iu, "");
  if (!allowContact) {
    // A request can share a line with a factual answer: remove just the contact
    // sentence, preserving the amount and its conditions on the same line.
    reply = reply.replace(/(?:^|(?<=[.!?])\s+|\n)(?:(?:Баярлалаа[^.!?\n]*!\s*)?(?:Нэр,?\s*)?(?:Тантай\s+холбогдох\s+)?(?:утасны\s+)?дугаараа\s+(?:(?:бичнэ|үлдээнэ)\s+үү|бичээрэй|үлдээгээрэй)(?=$|[\s.!?—–])|(?:утасны\s+)?дугаараа\s+үлдээвэл\s+(?:манай\s+)?(?:аяллын\s+)?зөвлөх\s+(?:тантай\s+)?(?:удахгүй\s+)?холбогдоно(?=$|[.!?\n])|Please\s+(?:leave|share)\s+your\s+phone(?:\s+number)?(?=$|[.!?\n]))[.!?]?/giu, "");
    reply = reply.replace(/(^|\n)\s*[—–]\s*/g, "$1");
  }
  // Only discard later standalone clarification sentences. Conditions, quoted
  // questions and questions with factual numeric answers are not chopped.
  let questionSeen = false;
  reply = reply.replace(/(?:^|(?<=[.!?])\s+|\n)((?:Та\s+)?(?:Аль|Ямар|Хэзээ|Хэдүүлээ|Хэдэн\s+(?:хүн|настай)|Which|What|When|How\s+many)(?=\s|\?)[^?\n]*\?)/giu, (whole, question: string) => {
    if (!questionSeen) { questionSeen = true; return whole; }
    return /[\d₮]|https?:/u.test(question) ? whole : "";
  });
  return reply.replace(new RegExp(`${prefix}(\\d+)END`, "g"), (_, index: string) => urls[Number(index)]);
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
  const compact = removeReplyPadding(reply, wantsContact && !input.phoneAlreadyRequested);
  // Cleanup only trims padding around an answer. When nothing else is left the
  // reply IS the answer (a booking flow's one phone question, a bare greeting):
  // an empty result would be read as "no data" and silence the customer.
  reply = compact.trim() ? compact : reply;
  // An icon that opens a line (\u2708\uFE0F name, \u23F3 length, \uD83D\uDCB0 fare, \uD83D\uDCC5 dates) is layout, not
  // decoration: the owner wants trip cards and lists scannable. Only emojis inside
  // the text are limited to one per reply.
  let emojis = 0;
  reply = reply.replace(/https?:\/\/\S+|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu,
    (value, offset: number, whole: string) => value.startsWith("http") || /(?:^|\n)[ \t]*$/.test(whole.slice(0, offset)) || ++emojis <= 1 ? value : "");
  // One blank line may separate blocks (list entries, card sections); longer gaps collapse.
  reply = reply.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return withoutBrokenValues(reply);
}

const BROKEN_VALUE = /(?<![\p{L}\p{N}])(?:undefined|null|NaN)(?![\p{L}\p{N}])|Invalid Date/u;

/**
 * A code placeholder never reaches a customer: "📅 undefined/undefined" went out in every
 * list holding a weekly-schedule trip (live 2026-10-30). A line carrying one is dropped (links
 * are not inspected); a reply with nothing else left becomes REFER, the silent staff hand-off.
 */
export function withoutBrokenValues(reply: string): string {
  if (!BROKEN_VALUE.test(reply.replace(/https?:\/\/\S+/g, " "))) return reply;
  const kept = reply.split("\n").filter((line) => !BROKEN_VALUE.test(line.replace(/https?:\/\/\S+/g, " ")))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return /[\p{L}\p{N}]/u.test(kept) ? kept : "REFER";
}
