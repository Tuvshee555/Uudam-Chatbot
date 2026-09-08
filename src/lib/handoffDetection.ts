export function normalizeLowerText(value: string): string {
  return value.trim().toLowerCase();
}

export function isFrustratedHandoffRequest(text: string): boolean {
  const normalized = normalizeLowerText(text).normalize("NFKC");
  if (!normalized) return false;
  return [
    /i\s+hate\s+you/i,
    /\byou(?:r|'re| are)?\s+(?:wrong|bad|useless|annoying)\b/i,
    /\bchatbot\b.{0,40}\b(?:wrong|bad|useless|annoying)\b/i,
    /\bbot\b.{0,40}\b(?:wrong|bad|useless|annoying)\b/i,
    /буруу\s+(?:байна|хариул|хэл|өг)/i,
    /худлаа\s+(?:байна|хэл|хариул)/i,
    /алдаатай\s+(?:байна|хариул)/i,
    /зөв\s+хариул/i,
    /чатбот.{0,40}(?:буруу|худлаа|алдаатай|муу)/i,
    /бот.{0,40}(?:буруу|худлаа|алдаатай|муу)/i,
    /арчаагүй|archaag(?:ui|umda|u?mda)?|archaagumda/i,
    /уур\s+хүр|уурлуул|дургүй\s+хүр/i,
    /оператор|operator|хүнтэй\s+холбо|зөвлөхтэй\s+холбо/i,
    // Natural ways a frustrated customer asks "isn't there a real person" —
    // distinct from "хүнтэй холбо" above (asking TO connect), this is asking
    // WHETHER a human even exists ("хүн байхгүй юу", "хүн алга юм уу").
    /хүн\s*(?:байхгүй|алга|үгүй)\s*(?:юм\s*)?(?:уу|бэ)?/i,
    /робот\s*биш/i,
  ].some((pattern) => pattern.test(normalized));
}

export function isHandoffRequest(text: string, keywords: string[]): boolean {
  const normalized = normalizeLowerText(text);
  if (!normalized) return false;
  if (isFrustratedHandoffRequest(normalized)) return true;
  for (const keyword of keywords) {
    const token = normalizeLowerText(keyword);
    if (token && normalized.includes(token)) return true;
  }
  return false;
}
