const WEBSITE_URL = "";
const WEBSITE_REPLY =
  "Төлбөрийн заавар, дансны мэдээллийг чат дээр баталгаажуулахгүй. Тухайн оператороос албан ёсоор баталгаажуулж авна уу.";

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

function normalizeWhitespace(text: string) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function splitSentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalizeForCompare(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function sanitizeAssistantReply(text: string) {
  const cleaned = normalizeWhitespace(stripMarkdown(text));
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

const BUTTONS_LINE_PATTERN = /\nBUTTONS:\s*(.+)$/;

export function extractButtons(text: string): { text: string; buttons: string[] } {
  const match = text.match(BUTTONS_LINE_PATTERN);
  if (!match) return { text, buttons: [] };
  const cleanText = text.slice(0, match.index).trim();
  const buttons = match[1]
    .split("|")
    .map((b) => b.trim())
    .filter((b) => b.length > 0 && b.length <= 60)
    .slice(0, 3);
  return { text: cleanText, buttons };
}

export function isDuplicateReply(
  previousReply: string | undefined,
  nextReply: string,
) {
  if (!previousReply) return false;
  return normalizeForCompare(previousReply) === normalizeForCompare(nextReply);
}
