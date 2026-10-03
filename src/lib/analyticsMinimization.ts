import { hashIdentifier } from "./observability";

const CREDENTIAL_KEY = /^(?:authorization|password|passwd|secret|clientsecret|token|accesstoken|refreshtoken|idtoken|apikey|pagetoken|tokenpage|appsecretproof|signature|sig)$/i;
const SECRET_TOKEN = /\b(?:EAA[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g;

function isCredentialUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === "postgres:" || url.protocol === "postgresql:" || url.username || url.password) return true;
    for (const [key, value] of url.searchParams) {
      if (CREDENTIAL_KEY.test(key.replace(/[^a-z]/gi, "")) || /^(?:EAA|sk-)/.test(value)) return true;
    }
    // Fragments are also commonly used to carry access tokens.
    const fragment = decodeURIComponent(url.hash.slice(1));
    return /(?:token|secret|password|api[_-]?key)\s*=|\b(?:EAA|sk-)/i.test(fragment);
  } catch {
    // Malformed URLs cannot be safely classified as public links.
    return true;
  }
}

export function redactAnalyticsText(text: string): string {
  return text
    .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s<>"']+/gi, raw => isCredentialUrl(raw) ? "[credential-url]" : raw)
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(SECRET_TOKEN, "[secret]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "[secret]")
    .replace(/["']?\b(?:authorization|password|passwd|secret|client[_-]?secret|(?:access[_-]?|refresh[_-]?|id[_-]?|page[_-]?)token|token[_-]?page|api[_-]?key|appsecret_proof)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[secret]")
    // Match mobile-shaped 4+4 digits, not general numeric text or currency.
    .replace(/(?<!\d)(?:\+?976[\s-]?)?[689]\d{3}[ -]?\d{4}(?!\d|[.,]\d)/g, (phone: string, offset: number, source: string) => {
      const before = source.slice(0, offset);
      const after = source.slice(offset + phone.length);
      if (/(?:\u20ae|\bMNT)\s*$/i.test(before) || /^\s*(?:\u20ae|MNT\b|\u0442\u04e9\u0433\u0440\u04e9\u0433)/i.test(after)) return phone;
      return "[phone]";
    });
}

/** Normalize only the minimized text that will be stored for display. */
export function normalizeQuestion(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function minimizeAnalyticsEntry(input: { platform: string; senderId: string; text: string }) {
  const text = redactAnalyticsText(input.text).slice(0, 500);
  return {
    platform: input.platform,
    senderId: hashIdentifier(JSON.stringify(["travel_messages", input.platform, input.senderId])),
    text,
    norm: normalizeQuestion(text).slice(0, 500),
  };
}
