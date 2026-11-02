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
    // "Хүнтэй ярьмаар байна", "huntei yarimaar", "ажилтантай ярья": wanting to TALK to a person.
    // "ярих" alone is not enough ("хүүхэдтэй ярих" is about a child); the person word must lead.
    /(?:хүнтэй|huntei|hvntei|ажилтантай|ajiltantai|зөвлөхтэй|zuvluhtei|zovlohtei|менежертэй|menejertei)\s+(?:ярь|яри|ярилц|уулз|yari|yarii|yarilts|uulz)/i,
    // "Хүн байна уу", "hun bnu", "ажилтан байна уу": the whole message asks whether a person is
    // there. A head count ("2 хүн байна уу") carries a digit and is not this.
    /^(?:сайн\s+байна\s+уу[,.!]?\s*)?(?:хүн|hun|hvn|ажилтан|ajiltan|оператор|operator|зөвлөх|zuvluh|zovloh)\s*(?:байна|бна|бн|baina|bna|bn)?\s*(?:уу|үү|юу|uu|yu|u|bnu|bnuu|бну|бнуу)\s*[?!.]*$/iu,
    // "Чатбот биш хүн хэрэгтэй", "bot bish", "жинхэнэ хүн": asking for a person instead of the bot.
    /(?:чатбот|chatbot|chat\s*bot|бот|bot|робот|robot)\s*(?:биш|bish)|(?:жинхэнэ|бодит|jinhene|bodit|амьд|amid)\s+(?:хүн|hun|hvn)/iu,
    // Natural ways a frustrated customer asks "isn't there a real person" —
    // distinct from "хүнтэй холбо" above (asking TO connect), this is asking
    // WHETHER a human even exists ("хүн байхгүй юу", "хүн алга юм уу").
    /хүн\s*(?:байхгүй|алга|үгүй)\s*(?:юм\s*)?(?:уу|бэ)?/i,
    /робот\s*биш/i,
    // "Хариу өгнө үү", "Юу болж байгаа вэ": the customer is waiting for a person. A
    // customer who wrote both got the same "which trip?" list three times (2026-10-21).
    /хариу\s*(?:өгөөч|өгнө\s*үү|өгөхгүй|өгөх\s*үү|бичээч)|hariu\s*(?:ug|ög|og)\S*/i,
    /юу\s*болж\s*(?:байна|байгаа|бн|бга)|yu\s*bolj\s*(?:baina|baigaa|bn|bga|bgaa)/i,
    // Messenger's stock opener for a page ("Is anyone available to chat?") asks for a
    // person, not a trip; it got "which trip?" from the model (2026-10-18).
    /\b(?:is\s+)?(?:any\s*one|some\s*one|anybody|somebody)\s+(?:available|there|online|here)\b/i,
    /\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:a\s+)?(?:human|person|real\s+person|agent|someone|staff)\b/i,
    // "Call me if a seat opens": a sold-out departure the customer still wants. Repeating
    // "суудал дүүрсэн" ignores the request; staff must take it.
    /суудал\s+(?:гарвал|гарвал|нэмэгдвэл|чөлөөлөгдвөл|гарах\s+бол)[\s\S]{0,40}(?:холбогд|мэдэгд|дуудаарай|залгаарай)/i,
    /suudal\s+(?:garwal|garval|nemegdvel)[\s\S]{0,40}(?:holbogd|medegd|zalgaarai)/i,
  ].some((pattern) => pattern.test(normalized))
    // "Хүн хэрэгтэй" (a person is needed) — but "3 хүн хэрэгтэй" counts seats, so no digit anywhere.
    || (!/\d/.test(normalized) && /(?:^|[^\p{L}])(?:хүн|hun|hvn)\s+(?:хэрэгтэй|heregtei|hergtei)(?:[^\p{L}]|$)/iu.test(normalized));
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
