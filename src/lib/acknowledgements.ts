/**
 * Messages that ask nothing: "за ok", "ойлголоо", "👍", and "I'll ask tomorrow" /
 * "let me think about it". They used to go to the free-text model (the most
 * expensive call the bot makes) and, when the model said REFER, staff were paged
 * for a customer who only said "ok". Answered here in one short line, no lead.
 *
 * Words that can be the answer to a question the bot just asked ("тийм", "үгүй",
 * a number) are deliberately NOT acknowledgements.
 */

const ACK_CORE = new Set([
  "за", "zaa", "za", "ok", "okay", "oк", "ок", "окей", "okey", "ойлголоо", "oilgoloo", "oilgolo", "ойлгосон", "oilgoson",
  "мэдлээ", "medlee", "medle", "болно", "bolno", "болчлоо", "bolchloo", "болчихлоо", "тэгье", "tegye", "tegie", "тэгээд", "зүгээр", "zugeer",
  "сайн", "sain", "гоё", "goyo", "👍", "👌", "🙏", "✅",
]);
const ACK_FILLER = new Set(["аа", "өө", "ээ", "aa", "ee", "тэгээд", "тэгэхээр", "мэдэж", "авлаа", "avlaa", "авсан", "байна", "бна", "bna", "bn", "шүү", "shuu", "ok", "за"]);

const DEFERRAL_RE = /(?:^|[^\p{L}])(?:маргааш|margaash|margash|дараа|daraa|удахгүй|udahgui|хожим|hojim)\s*(?:нь\s*)?(?:лавла|lavla|асуу|asuu|бич|bich|холбогд|holbogd|хэл|hel|мэдэгд|medegd|хариу|hariu|ярь|yari|ирье|irye|үзье|uzye)|(?:бодож|bodoj|бодоод|bodood|ярилцаад|yariltsaad|зөвлөлдөөд|zuvluldood|хэлэлцээд|heleltseed)\s*(?:үзье|uzye|uzie|узье|байна|baina|бна|bna|хэлье|helye|хэлнэ|helne|мэдэгдье|medegdye|шийдье|shiidye)|(?:^|[^\p{L}])(?:бодъё|бодьё|bodyo|bodio|бодно|bodno)(?:[^\p{L}]|$)/iu;

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\p{Extended_Pictographic}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/** "за ok", "ойлголоо", "за тэгье 👍": an acknowledgement and nothing else. */
export function isAcknowledgementOnly(text: string): boolean {
  const words = tokens(text);
  if (!words.length || words.length > 4) return false;
  return words.some((word) => ACK_CORE.has(word)) && words.every((word) => ACK_CORE.has(word) || ACK_FILLER.has(word));
}

/** "margaash lavlah gesen yum", "бодож үзье": the customer will come back later and asks nothing now. */
export function isDeferralOnly(text: string): boolean {
  const words = tokens(text);
  if (!words.length || words.length > 8 || /\d/.test(text)) return false;
  // A deferral that still asks something ("бодож үзье, үнэ хэд вэ") is answered as a question.
  if (/[?？]|хэд|hed|үнэ|une|vne|хэзээ|hezee|ямар|yamar|юу\s*$|yu\s*$/iu.test(text)) return false;
  return DEFERRAL_RE.test(text);
}

export const ACKNOWLEDGEMENT_REPLY = "За 😊 Асуух зүйл гарвал бичээрэй.";
export const DEFERRAL_REPLY = "За, тухтай бодоорой 😊 Асуулт гарвал хэзээ ч бичээрэй.";
