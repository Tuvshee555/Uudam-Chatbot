const WEBSITE_URL = "";
const WEBSITE_REPLY =
  "Төлбөрийн заавар, дансны мэдээллийг чат дээр баталгаажуулахгүй. Тухайн оператороос албан ёсоор баталгаажуулж авна уу.";

/**
 * REFER protocol — the model's machine-readable "I don't have this data"
 * signal. The old SILENT rule dropped the customer's message with no reply
 * and no staff alert (a silently lost lead). Now the model outputs REFER and
 * the CALLER converts it into a polite consultant fallback + staff alert +
 * lead. "SILENT" is kept as a legacy alias so an older cached prompt or a
 * stubborn model can't regress us to dropping messages.
 *
 * Lives here (env-free reply helpers) rather than in conversation.ts so tests
 * and callers can use it without dragging in the DB/env import chain.
 */
export function isReferReply(text: string): boolean {
  const firstLine = (text || "").trim().split("\n")[0]?.trim().toUpperCase() ?? "";
  return firstLine === "REFER" || firstLine === "SILENT" || /^(REFER|SILENT)\b/.test(firstLine);
}

/** Customer-facing fallback sent instead of REFER. No hardcoded phone numbers here. */
export const REFER_FALLBACK_REPLY =
  "Энэ мэдээллийг манай аяллын зөвлөхөөс тодруулж хэлье 🙌 Утасны дугаараа үлдээвэл зөвлөх тан руу шууд холбогдоно.";

const PAYMENT_LEAK_PATTERNS: RegExp[] = [
  /\/register/i,
  /регистер\s*хуудас/i,
  /register\s*page/i,
  /данс\s*(?:руу\s*)?шилжүүл/i,
  /данс(?:аар|ны\s*дугаар)/i,
  /qpay\s*(?:эсвэл|болон|-?р\s*төл|-?аар\s*төл)/i,
  /(?:qpay|кюпэй).{0,30}(?:төл|шилжүүл)/i,
  /төлбөрийг\s*(?:qpay|кюпэй|данс)/i,
];

function containsLeakedPaymentInstruction(text: string) {
  if (!text) return false;
  if (WEBSITE_URL && text.includes(WEBSITE_URL)) return false;
  return PAYMENT_LEAK_PATTERNS.some((pattern) => pattern.test(text));
}

export function enforceWebsiteForPayment(text: string) {
  if (containsLeakedPaymentInstruction(text)) return WEBSITE_REPLY;
  return text;
}

export function reconcilePhotoAttachmentReply(text: string, hasAttachedMedia: boolean) {
  if (!hasAttachedMedia) return text;
  return text.replace(
    /\n\nОдоогоор энэ аяллын нэмэлт зураг системд ороогүй байна\. 🙌/g,
    "\n\nЗургийг илгээж байна.",
  );
}

// A customer's own text claim ("5 сая шилжүүлсэн", "screenshot явуулсан",
// "миний төлбөр орсон уу?") is not proof of payment — the bot has no bank/QPay
// access and can only see what the customer typed. The model is prompted not
// to confirm from this, but a money-trust claim needs a code-level backstop
// too: this pattern set matches the customer message, not the reply, so it
// only fires when the conversation is actually about a payment claim.
const PAYMENT_CLAIM_PATTERNS: RegExp[] = [
  /шилжүүл(?:сэн|лээ|эв)/i,
  /төл(?:сөн|лөө|бөр).{0,20}(?:орсон|хийсэн|хийлээ)/i,
  /баримт/i,
  /screenshot|скриншот/i,
  /миний төлбөр орсон уу/i,
  /баталгаажуул/i,
  /данс руу шилжүүл/i,
];

// The reply text asserting confirmation — this is what must never leave the
// bot for a text-only payment claim, regardless of what the customer typed.
const PAYMENT_CONFIRMATION_CLAIM_PATTERNS: RegExp[] = [
  /захиалг(?:а|ыг).{0,20}баталгаажс?/i,
  /төлбөр(?:ийг)?.{0,20}хүлээн авлаа/i,
  /баталгаажуулж байна/i,
  /баталгаажсан байна/i,
  /зөв байх ёстой/i,
];

export const PAYMENT_VERIFICATION_DEFERRAL_REPLY =
  "Төлбөр, захиалгын баталгаажуулалтыг манай аяллын зөвлөх л шалгаж хийдэг тул би чат дээр баталгаажуулж чадахгүй. Зөвлөх тантай удахгүй холбогдож шалгаад мэдэгдэх болно 🙏";

// Stricter than PAYMENT_CLAIM_PATTERNS above — that set includes a bare
// /баримт/i, which also matches innocent questions like "бичиг баримт
// хэрэгтэй юу?" (visa document question). Fine for its original job (only
// fires if the REPLY separately also claims confirmation — a rare
// coincidence), but too broad to gate fast-path routing on: it would make a
// document question get told "only the consultant can verify payments"
// instead of answered. This set requires an unambiguous money-transfer or
// payment-proof signal.
const STRONG_PAYMENT_CLAIM_PATTERNS: RegExp[] = [
  /шилжүүл(?:сэн|лээ|эв)/i,
  /төл(?:сөн|лөө|өв)/i,
  /төл(?:сөн|лөө|бөр).{0,20}(?:орсон|хийсэн|хийлээ)/i,
  /\d[\d\s,.]{4,}.{0,30}(?:төл(?:сөн|лөө|өв)|шилжүүл|баталгаажуул)/i,
  /screenshot|скриншот/i,
  /миний төлбөр орсон уу/i,
  /данс руу шилжүүл/i,
  /(?:төлбөр|захиалг(?:а|ыг)).{0,15}баталгаажуул/i,
];

/**
 * True when the customer's OWN message is itself a payment/booking
 * confirmation claim ("5 сая шилжүүлсэн", "screenshot явуулсан"). Callers use
 * this to short-circuit trip/date/price fast-paths BEFORE they run — those
 * fast-paths are blind text/number matchers and were hijacking payment claims
 * (e.g. "5 сая шилжүүлсэн" matched a trip alias containing "5 өдөр", "8 сая"
 * matched August availability) into an unrelated trip reply instead of
 * acknowledging the payment claim at all.
 */
export function hasPaymentClaimIntent(userText: string): boolean {
  return STRONG_PAYMENT_CLAIM_PATTERNS.some((pattern) => pattern.test(userText));
}

/**
 * Backstops the prompt rule: no matter what the model wrote, a text-only
 * payment claim must never come back as a confirmed booking/payment. Only
 * runs when the customer's OWN message is a payment claim — normal trip
 * questions that happen to mention "баталгаажуулах" in another sense are
 * unaffected because the reply-side pattern also has to match.
 */
export function enforcePaymentNeverSelfConfirmed(userText: string, replyText: string) {
  const claimsPayment = PAYMENT_CLAIM_PATTERNS.some((pattern) => pattern.test(userText));
  if (!claimsPayment) return replyText;
  const confirmsInReply = PAYMENT_CONFIRMATION_CLAIM_PATTERNS.some((pattern) =>
    pattern.test(replyText),
  );
  if (!confirmsInReply) return replyText;
  return PAYMENT_VERIFICATION_DEFERRAL_REPLY;
}

// The AI prompt shows the model a fill-in-the-blank example ('[Чиглэл]
// чиглэлд 3 өөр аялал байна...') so it can copy the sentence shape. The model
// occasionally echoes the literal bracket placeholder instead of substituting
// the real destination name — this strips the token so a leaked "[Чиглэл]"
// never reaches a customer even if the prompt instruction is ignored.
function stripLeakedPlaceholders(text: string): string {
  return text.replace(/\[Чиглэл\]\s*/gi, "");
}

function stripMarkdown(text: string): string {
  return text
    // [link text](url) → just the url
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, "$2")
    // **bold** or __bold__ → plain
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    // *italic* or _italic_ → plain
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    // # headers → plain
    .replace(/^#{1,6}\s+/gm, "")
    // bullet points * or - at line start → plain
    .replace(/^[\*\-]\s+/gm, "")
    // dedupe consecutive identical URLs on separate lines
    .replace(/(https?:\/\/[^\s]+)\n\1/g, "$1");
}

function stripControlTokens(text: string): string {
  return text
    .replace(/(^|\s)\b(?:REFER|SILENT)\b(?=\s|$)/gi, " ")
    .replace(/[ \t]{2,}/g, " ");
}

function stripScoldingRepeatPhrases(text: string): string {
  return text
    .replace(/[^.\n!?]*өмнө нь хэлсэн[^.\n!?]*[.!?]?/gi, "")
    .replace(/[^.\n!?]*as I mentioned[^.\n!?]*[.!?]?/gi, "")
    .replace(/[^.\n!?]*already (?:told|shared)[^.\n!?]*[.!?]?/gi, "");
}

function normalizeWhitespace(text: string) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeForCompare(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isGreetingBlock(text: string) {
  const normalized = normalizeForCompare(text);
  return (
    normalized.startsWith("сайн байна") ||
    normalized.startsWith("сайн уу") ||
    normalized.startsWith("тавтай морил") ||
    normalized.startsWith("hello") ||
    normalized.startsWith("hi ")
  );
}

export function sanitizeAssistantReply(text: string) {
  const cleaned = normalizeWhitespace(stripScoldingRepeatPhrases(stripControlTokens(stripMarkdown(stripLeakedPlaceholders(text)))));
  if (!cleaned) return "Энэ мэдээлэл одоогоор тодорхойгүй байна. Хүний ажилтантай холбож өгье.";

  // Split on blank lines (paragraph breaks) — preserve them so the AI's
  // line-by-line trip details format (price on one line, date on next, etc.)
  // is kept intact when sent to Messenger.
  const blocks = cleaned.split(/\n\n+/);
  const dedupedBlocks: string[] = [];
  const seenLines = new Set<string>();

  for (const block of blocks) {
    // Within each block, deduplicate individual lines (not sentences) so
    // the emoji-prefixed detail lines are each preserved separately.
    const lines = block.split("\n");
    const uniqueLines: string[] = [];
    for (const line of lines) {
      const norm = normalizeForCompare(line);
      if (!norm || seenLines.has(norm)) continue;
      seenLines.add(norm);
      uniqueLines.push(line.trim());
    }
    if (uniqueLines.length) {
      dedupedBlocks.push(uniqueLines.join("\n"));
    }
  }

  return dedupedBlocks.join("\n\n").trim() || "Энэ мэдээлэл одоогоор тодорхойгүй байна. Хүний ажилтантай холбож өгье.";
}

export function stripRepeatedGreeting(replyText: string, hasPriorAssistantReply: boolean) {
  if (!hasPriorAssistantReply) return replyText;
  const blocks = replyText.split(/\n\n+/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length <= 1) return replyText;
  if (!isGreetingBlock(blocks[0])) return replyText;
  return blocks.slice(1).join("\n\n").trim();
}

const BUTTONS_LINE_PATTERN = /\nBUTTONS:\s*(.+)$/;

export function extractButtons(text: string): { text: string; buttons: string[] } {
  const match = text.match(BUTTONS_LINE_PATTERN);
  if (!match) return { text, buttons: [] };
  const cleanText = text.slice(0, match.index).trim();
  const buttons = match[1]
    .split("|")
    .map((b) => b.trim())
    .filter((b) => b.length > 0 && b.length <= 60)
    // The prompt promises up to 10 buttons (one per trip in disambiguation
    // lists); slicing to 3 silently cut those taps. Messenger allows 13.
    .slice(0, 10);
  return { text: cleanText, buttons };
}

export function isDuplicateReply(
  previousReply: string | undefined,
  nextReply: string,
) {
  if (!previousReply) return false;
  return normalizeForCompare(previousReply) === normalizeForCompare(nextReply);
}

function isGenericTripClarifier(text: string) {
  const normalized = normalizeForCompare(text);
  return (
    normalized.includes("ямар аялалд сонирхож байна вэ") ||
    normalized.includes("тодорхой мэдээлэл өгвөл илүү сайн туслах боломжтой") ||
    normalized.includes("сонирхож байгаа аяллынхаа нэрийг бичиж үлдээнэ үү")
  );
}

function isLowSignalFollowUp(text: string) {
  const normalized = normalizeForCompare(text);
  if (!normalized) return true;
  if (normalized.length <= 18) return true;
  if (/^\d{6,8}$/.test(normalized)) return true;
  return (
    normalized.includes("kkk") ||
    normalized.includes("haha") ||
    normalized.includes("hehe") ||
    normalized.includes("би бна") ||
    normalized.includes("mun bna") ||
    normalized.includes("мөн bna") ||
    normalized.includes("мөн байна") ||
    normalized.includes("say utsaar") ||
    normalized.includes("утсаар") ||
    normalized.includes("ярьсан") ||
    // Word-boundary matches: substring "за"/"ok" wrongly fired on "Захиалах"
    // ("за…") and romanized "Tokio" ("…ok…"), muting real trip questions.
    /(^|\s)за($|\s)/.test(normalized) ||
    /(^|\s)ok($|\s)/.test(normalized)
  );
}

function hasRecentStructuredTripReply(recentAssistantReplies: string[]) {
  return recentAssistantReplies.some(
    (reply) =>
      reply.includes("✈️") &&
      (reply.includes("💰") || reply.includes("📅") || reply.includes("өдөр")),
  );
}

export function rewriteRepeatedGenericClarifier(input: {
  userText: string;
  replyText: string;
  recentAssistantReplies: string[];
}) {
  const { userText, replyText, recentAssistantReplies } = input;
  if (!isGenericTripClarifier(replyText)) return replyText;

  const alreadyAskedRecently = recentAssistantReplies.some((reply) =>
    isGenericTripClarifier(reply),
  );
  if (!alreadyAskedRecently) return replyText;

  if (hasRecentStructuredTripReply(recentAssistantReplies)) {
    return "Ойлголоо 😊 Дээрх аяллын талаар үнэ, хугацаа, гарах өдөр, эсвэл хүүхдийн үнээс аль нь хэрэгтэйгээ бичээрэй.";
  }

  if (isLowSignalFollowUp(userText)) {
    return "Ойлголоо 😊 Сонирхож байгаа аяллынхаа нэрийг нэг бичээрэй, эсвэл үнэ, өдөр, гарах огнооноос аль нь хэрэгтэйгээ хэлээрэй.";
  }

  return "Аль аяллын талаар мэдээлэл авах вэ? Аяллын нэрээ нэг бичээрэй. 😊";
}
