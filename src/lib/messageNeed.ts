/**
 * Message need: what KIND of help the customer wants, read from their own words BEFORE any
 * catalogue retrieval acts on the message.
 *
 * The bot used to ask "which trip, and which field of it?" for every message, so a place word or a
 * trip title forced the trip pipeline and a message with no home (thanks, an organisation asking for
 * a trip, barter, a ticket-only wish, a booking already made, a complaint) became a price card, a
 * phone ask, a list of trips or the "system is down" line. This module names those classes.
 *
 * Pure, no model, no I/O. Precision first: it answers only for closed, high-signal shapes and returns
 * null otherwise, so every ordinary trip question (price, date, programme, hotel, weather, a head
 * count under a trip card, "2 том 2 хүүхэд", a trip question that merely contains a thanks word)
 * keeps today's path. Words are matched in Cyrillic and in the Latin spellings customers type.
 */
import { normText } from "./travelTextNorm";
import { isBookingStatusQuestion } from "./bookedFollowup";
import { isThanksOnly } from "./greetingPhrases";
import { isGroupInquiryReply } from "./groupInquiry";

export const MESSAGE_NEEDS = ["social", "business_group", "commercial_policy", "transport_only", "existing_booking", "complaint"] as const;
export type MessageNeed = (typeof MESSAGE_NEEDS)[number];
/** thanks/praise get a short warm line; an acknowledgement or farewell is met with silence. */
export type SocialKind = "thanks" | "praise" | "ack" | "farewell";

export type NeedConstraints = {
  /** The largest head count the customer wrote (a range "50-60" gives 60). */
  groupSize?: number;
  /** Destination words as the customer typed them (hints for staff; not trip identities). */
  destinationWords?: string[];
  /** Month 1-12 when "2 сарын эхээр" / "2-р сард" is written. */
  month?: number;
  /** A named period without a month number ("шинэ жил"). */
  period?: string;
  /** A budget is mentioned (төсөв, a sum): the reply must not ask for one again. */
  budgetMentioned?: boolean;
};

export type NeedContext = {
  /** The bot's last reply in this conversation, when there is one. */
  lastBotReply?: string | null;
};

export type MessageNeedResult = {
  need: MessageNeed;
  /** Only for need "social". */
  social?: SocialKind;
  /** Which cues fired (no customer text). */
  signals: string[];
  constraints: NeedConstraints;
};

type Prepared = { raw: string; norm: string; tokens: string[] };

function prepare(text: string): Prepared {
  const raw = (text || "").toLowerCase().normalize("NFKC");
  const norm = normText(raw).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return { raw, norm, tokens: norm ? norm.split(" ") : [] };
}

// ── shared building blocks ───────────────────────────────────────────────────────────────────────

/** Question particles and interrogatives, Cyrillic and Latin ("u" is the typed "уу"). */
const QUESTION_TOKENS = new Set([
  "уу", "үү", "юу", "юү", "вэ", "бэ", "хэд", "хэдэн", "ямар", "хэзээ", "хаана", "хаашаа", "яаж", "яагаад", "аль", "хэр", "хэрхэн", "хэн", "ямарч",
  "uu", "u", "yu", "ve", "be", "hed", "heden", "yamar", "hezee", "haana", "haashaa", "yaaj", "yagaad", "ali", "her", "herhen", "hen",
]);

function asksSomething(p: Prepared): boolean {
  // "бнауу", "байгаауу": the particle typed without a space.
  return /[?？]/.test(p.raw) || p.tokens.some((token) => QUESTION_TOKENS.has(token) || (token.length >= 4 && /(?:уу|үү)$/u.test(token)));
}

/** Imperative / optative requests ("илгээнэ үү", "өгөөч", "захиалъя"); past participles ("өгсөнд") are thanks, not requests. */
const REQUEST_VERB = /(?:^|\s)(?:илгээ|явуул|өг|хэл|мэдэгд|үзүүл|тайлбарл|тодруул|шалга|холбогд|залга|захиал|бүртгэ|сонирхо|авъя|авья|хүс(?!эл))(?!сэн|сөн|сан|сон|эн|өн|аад|ээд|оод|өөд|лаа|лээ|лоо|сөнд|сэнд|лөө)\p{L}*|(?:^|\s)(?:ilge|yavuul|ywuul|ugooc|ugnu|hel(?:eec|nu)|medegd|zahial|burtg|avya|avii)\p{L}*/u;

/**
 * In a long narrative (a thank-you of several sentences) "хэлэх" (to say) or "хүсье" (we wish) is no request: only a
 * request FORM counts there (a polite imperative or "…нэ үү"), not any word that starts with a request verb.
 */
const REQUEST_FORM = /(?:^|\s)\p{L}*?(?:илгээ|явуул|өг|хэл|мэдэгд|үзүүл|тайлбарл|тодруул|шалга|холбогд|залга|захиал|бүртгэ)\p{L}*?(?:аарай|ээрэй|оорой|өөрэй|аач|ээч|өөч|нэ\s+(?:үү|уу)|на\s+уу)(?=\s|$)|(?:^|\s)(?:ilge|yavuul|ywuul|ugooc|ugnu|medegd|zahial|burtg)\p{L}*(?=\s|$)/u;

const NUMBER_WORDS: Record<string, number> = {
  арван: 10, хорин: 20, гучин: 30, дөчин: 40, тавин: 50, жаран: 60, далан: 70, наян: 80, ерөн: 90, зуун: 100,
  arvan: 10, horin: 20, gucin: 30, guchin: 30, docin: 40, dochin: 40, tavin: 50, jaran: 60, dalan: 70, nayan: 80, eron: 90, zuun: 100,
};

/** "50-60 хүн", "40-45 hun", "20s 25 hun", "35 ажилтан", "хорин хүн": the largest head count, or null. */
export function headcountIn(text: string): number | null {
  const raw = (text || "").toLowerCase().normalize("NFKC");
  const people = "(?:хүн(?!с)|хүний|хүнтэй|хүнээр|hun(?!s)|huntei|huniii?|ажилт\\p{L}*|ажилч\\p{L}*|ajilt\\p{L}*|ajilch\\p{L}*|сурагч|surag|оюутан|oyutan|багш\\p{L}*|bagsh\\p{L}*|гишүү\\p{L}*|аялагч\\p{L}*|pax|people|persons?|tourists?)";
  let best: number | null = null;
  const numeric = new RegExp(`(\\d{1,3})\\s*(?:[a-zа-я]{0,2}\\s*[-–—~]\\s*|[a-zа-я]{1,2}\\s+)?(\\d{1,3})?\\s*${people}`, "giu");
  for (const match of raw.matchAll(numeric)) {
    for (const group of [match[1], match[2]]) {
      const value = Number(group);
      if (Number.isFinite(value) && value > 0 && value <= 500) best = Math.max(best ?? 0, value);
    }
  }
  const words = new RegExp(`(?:^|[^\\p{L}])(${Object.keys(NUMBER_WORDS).join("|")})\\s+${people}`, "giu");
  for (const match of raw.matchAll(words)) best = Math.max(best ?? 0, NUMBER_WORDS[match[1]] ?? 0);
  return best;
}

/** Adults + children written as "2 том 2 хүүхэд": the party size, for staff reading a custom-quote request. */
function partySizeIn(raw: string): number | null {
  let total = 0;
  for (const match of raw.matchAll(/(\d{1,3})\s*(?:том\s*хүн|том|насанд\s*хүрэгч|adults?|tom|хүүхэд|huuhed|child(?:ren)?|нярай|nyarai|infants?|ширхэг\s*хүн)/giu)) total += Number(match[1]);
  return total > 0 && total <= 500 ? total : null;
}

// ── organisation / group / bespoke travel ────────────────────────────────────────────────────────

const ORG_STRONG: RegExp[] = [
  /^байг[уү]+л+аг\p{L}*$/u, /^baig?u+l+a?g\p{L}*$/u, /^baig[uü]+l+\p{L}*$/u,
  /^компани\p{L}*$/u, /^kompani\p{L}*$/u, /^(?:company|companies|corporate|corporation)$/u, /^корпорат\p{L}*$/u,
];
// Tested against the tokens from each position on (so a leading "танай" / "бусад" can be seen), anchored at the start.
const ORG_BIGRAM = /^(?:(?:хамт|hamt)\s?(?:ол(?:он|ны|но)|olo?n|olni)\p{L}*|(?:албан|alban)\s+(?:хаагч|haagc)\p{L}*|team\s?building|тим\s?билдинг)/u;
/** Count only with a head count of 10+: these words are everyday ("ажилтантай холбогдох"). */
const ORG_WEAK: RegExp[] = [
  /^(?:ажилт|ажилч)\p{L}*$/u, /^(?:ajilt|ajilch|ajilcd)\p{L}*$/u,
  /^(?:баг|багт|багийн|багаар|багтай|багийг|багууд|багуудыг)$/u, /^(?:bag|bagt|bagiin|bagaar|bagtai|baguud)$/u,
  /^(?:сургуул|сурагч|оюутн|клуб|холбоо|хороо|нийгэмлэг)\p{L}*$/u, /^(?:surguul|surag|oyutan|club|holboo)\p{L}*$/u,
];
const YOUR = new Set(["танай", "таны", "танайх", "танд", "tanai", "tanii", "tani", "tanaih", "your"]);
/** "Busad aylal kompani": other agencies, not the customer's own organisation. */
const OTHER_ORG = new Set(["бусад", "бусдын", "өөр", "ондоо", "busad", "busdiin", "uur", "other", "others"]);

function orgHits(p: Prepared): { strong: boolean; weak: boolean } {
  let strong = false;
  let weak = false;
  p.tokens.forEach((token, index) => {
    // "Танай байгууллага" is the agency's own organisation and "бусад компани" other agencies, not the customer's.
    if (p.tokens.slice(Math.max(0, index - 2), index).some((prior) => YOUR.has(prior) || OTHER_ORG.has(prior))) return;
    if (ORG_BIGRAM.test(p.tokens.slice(index, index + 3).join(" "))) strong = true;
    if (ORG_STRONG.some((pattern) => pattern.test(token))) strong = true;
    else if (ORG_WEAK.some((pattern) => pattern.test(token))) weak = true;
  });
  return { strong, weak };
}

const TRAVEL_CUE = /(?:^|\s)(?:аял\p{L}*|ayl\p{L}*|яв\p{L}*|yav\p{L}*|yaw\p{L}*|ywa\p{L}*|тур|tour|trip|travel|амрал\p{L}*|амрах|amral\p{L}*|хөтөлбөр\p{L}*|маршрут\p{L}*|marsh?rut\p{L}*|нислэг\p{L}*|багц\p{L}*)(?=\s|$)/u;
const DISCOUNT_CUE = /хямдр|хөнгөлөлт|hymdr|hamdr|hyamdr|hongol|hungul|discount|урамшуул/u;

/** A route/programme the customer wants made for them, or a quote outside the standard programmes. */
const CUSTOM_MARKERS: RegExp[] = [
  /тусгай\s+маршрут|tusgai\s+mars?h?rut/u,
  /тусгайлан\s+(?:хөтөлбөр|маршрут)|tusgailan\s+(?:hutulbur|marshrut)/u,
  /(?:өөрсдийн|өөрийн|өөрсдөө\s+сонг\p{L}*|manai\s+hussen|oorsdiin|ooriin)\s+(?:хүссэн\s+)?(?:маршрут|хөтөлбөр|marsh?rut|hutulbur)/u,
  /(?:маршрут|marsh?rut)\p{L}*\s+(?:гаргуул|гаргаж|гарга|зохион|төлөвл|тохирууль|garguul)/u,
  /хөтөлбөр\p{L}*\s+(?:гаргуул|гаргаж|зохион|боловсруул)/u,
  /хөтөлбөрт\s+хамрагд\p{L}*|хамрагдахгүй/u,
  /багцаас\s+гадуур|багцгүй|тус\s+тусад\s+нь/u,
];
/** "Үнийн санал" alone is an everyday phrase; it means a bespoke quote only beside itemised services. */
const QUOTE_CUE = /үнийн\s+санал|uniin\s+sanal|quotation|\bquote\b|нийт\s+үнэ|тооцоо|тооцоол|total/u;
const SERVICE_FAMILIES: RegExp[] = [
  /нислэг|тийз|билет|nisleg|ticket|flight/u, /буудал|hotel|buudal|байр|өрөө/u, /трансфер|transfer|унаа|тээвэр|угтах|хүргэх/u,
  /даатгал|daatgal|insurance/u, /виз(?:\s|$)|visa/u, /хоол|hool|meal/u, /хөтөч|guide/u, /экскурс|үзвэр|excursion/u,
];
const INCLUDED_QUESTION = /багтсан|багтсан|орсон|үнэд|included|багтаж|багтдаг|орно/u;

// ── commercial policy ────────────────────────────────────────────────────────────────────────────

const BARTER = /бартер|barter|барте|солилцож\s+(?:аял|яв)|бүтээгдэхүүнээр\s+(?:төл|аял)|бараагаар/u;
const INVOICE = /нэхэмжлэ[хл]|nehemjle|и-?баримт|e-?barimt|ebarimt|ибаримт/u;
const CONTRACT = /гэрээ\p{L}*|geree\p{L}*/u;
const CONTRACT_CONTEXT = /байгууллаг|baig|төл|tol|tul|нэхэмж|компани|kompani|корпорат/u;
const INSTALMENT = /хэсэгчлэн|хуваа[жн]?\s+төл|хуваж\s+төл|сараар\s+(?:хуваа[жн]?\s+)?төл|зээл|лизинг|рассрочк|storepay|pocket|монпай|monpay|кредит|hesegcleen|hesegchlen/u;
const PAY_CUE = /төл|tol|tul|pay|авах|аял/u;
const CARD_PAY = /карт(?:аар|ыг|ны)?\s+(?:төл|tul)|kart(?:aar)?\s+(?:tul|tol)/u;
const GROUP_WORD = /(?:^|\s)(?:групп\p{L}*|group|олуулаа|олон\s+хүн)(?=\s|$)/u;

// ── transport / pick-up / ticket only ────────────────────────────────────────────────────────────

const TICKET_TOKEN = /^(?:тийз|тийзээ|тийзийг|тийзний|тийзнээс|тийзэнд|тасалбар|тасалбараа|билет|билетээ|билетийг|билетүүд|ticket|tickets|tiiz|tiz|tizee|bilet|biletee)$/u;
const TICKET_ONLY_MARK = /(?:^|\s)(?:л|l|зөвхөн|only|тусад|тусдаа|нэг\s+тал(?:ын|даа)|буцах|буцахдаа|одоо\s+л)(?=\s|$)|аялал\s+биш|аялалгүй|ayl?al\s+bish|ayl?al\s+bui|tusad|tusdaa/u;
const PICKUP = /хүн\s+(?:авах|авдаг|авна|авч\s+(?:болох|чадах))|хүн\s+хүргэ|хүн\s+тээв|ачаа\s+тээв|hun\s+(?:avah|avdag|avna)|угтан\s+авах|угтаж\s+авах|тосож\s+авах|нисэх\s+буудл\p{L}*\s+(?:аас|ээс|оос|өөс)?\s*(?:авах|угт|авч)|airport\s+(?:pick\s?up|transfer)|\bpick\s?-?up\b/u;
const DELIVER = /хүргэж\s+(?:өг|өгч|өгөх|өгөөч)|hurgej\s+ug/u;
const MOVEMENT = /(?:^|\s)\p{L}*(?:хүртэл|руу|луу|рүү|хилээс|орох|ирэх|буцах|гарах|aas|ees|ruu|luu|hurtel|orah|irah|butsah)(?=\s|$)|\p{L}+(?:аас|ээс|оос|өөс)(?=\s|$)/u;
const HOTEL_ONLY = /буудал\s+(?:захиал|авах)|buudal\s+(?:zahial|avah)/u;

// ── existing booking ─────────────────────────────────────────────────────────────────────────────

const OWN_BOOKING = /захиалгаа|захиалга\s*(?:маань|минь|чинь)|миний\s+захиалга|захиалсан|захиалчихсан|захиалж\s+авсан|захиалгын\s+(?:дугаар|төлөв|мэдээлэл)|zahialgaa|zahialga\s*(?:maani|mini|minii)|minii\s+zahialga|zahialsan|zahialchihsan|my\s+(?:booking|reservation|order)/u;
const BOOKING_ACTION = /цуцл|цуцал|cuclah|cancel|буцаан\s+(?:ав|олго)\p{L}*|буцаалт|мөнгө\s+буцаа|refund|өөрчил|өөрчл|хойшлуул|шилжүүл|reschedule|баталгаажс|баталгаажл|баталгаажуулс|батлагд|батлуулс|юу\s+болсон|яасан|хаана\s+явна|ямар\s+байдалтай|төлөв|batalgaajs|batlagd|yu\s+bolson|uurchl|oorchl|urchl|hoishluul|status/u;

// ── complaint ────────────────────────────────────────────────────────────────────────────────────

const COMPLAINT_NOUN = /гомдол\p{L}*|gomdol\p{L}*/u;
const COMPLAINT_STRONG = /сэтгэл\s+дундуур|sethel\s+dundur|хуурсан|залилсан|хохирсон|ёс\s?зүйгүй|муухай\s+ханд|доромж|disappoint|terrible|awful|worst|scam|rude/u;
const SERVICE_NOUN = /хоол|хөтөч|буудал|үйлчилгээ|нислэг|унаа|жолооч|зохион\s+байгуулалт|аялал|hool|hutuc|uilchilgee/u;
// "Мэдээлэл өгсөнд баярлалаа": thanks FOR something done (a past participle), not a request.
const THANKS_FOR = /\p{L}+(?:сөнд|сэнд|санд|сонд|сөнийг|сэнийг)(?=\s|$)/u;
const PAST_MARK =/байсан|байлаа|боллоо|болсон|болов|өнгөрлөө|өнгөрсөн|таалагдлаа|таалагдсан|baisan|bolloo|bolson|bailaa|taalagdlaa|taalagdsan/u;

// ── social ───────────────────────────────────────────────────────────────────────────────────────

const THANKS_TOKEN = /^(?:баярл\p{L}*|ачлалаа|мерси|merci|thanks?|thankyou|thx|tnx|ba[iy]a?r?la(?:laa?)?a?|bayrla\p{L}*)$/u;
const PRAISE_WORD = /сайхан|гайхалтай|супер|төгс|тансаг|таалагд\p{L}*|сэтгэл\s+хангалуун|сэтгэл\s+ханас\p{L}*|saihan|gaihaltai|excellent|awesome|amazing|wonderful|great|super/u;
const ACK_WORDS = new Set([
  "ok", "ок", "okay", "okey", "окей", "ойлголоо", "ойлгомжтой", "ойлгосон", "oilgolo", "oilgoloo", "oilgomjtoi", "тодорхой", "ойлгомжтой",
  "за", "zaa", "za", "аа", "аан",
]);
const ACK_CORE = new Set(["ok", "ок", "okay", "okey", "окей", "ойлголоо", "ойлгомжтой", "ойлгосон", "oilgolo", "oilgoloo", "oilgomjtoi"]);
/** Polite closes: "за бодоод үзье", "дараа холбогдоно". */
const CLOSE_PHRASE = /бодоод\s+үзье|бодож\s+үзье|бодоод\s+харья|bodood\s+uzie|bodood\s+uzii|дараа\s+(?:нь\s+)?(?:холбогдоно|бичье|ярья|ярилцъя|харья)|daraa\s+(?:bichie|holbogdono)/u;
const FAREWELL = /баяртай|bayartai|\bbye\b|goodbye|сайхан\s+амраарай|сайхан\s+өнгөрүүлээрэй|амжилт\s+хүсье|амжилт\s+хүсэе/u;
const CONTENT_NOUN = /(?:^|\s)(?:үнэ|хөтөлбөр\p{L}*|огноо|зураг|буудал|нислэг|мэдээлэл|захиалга\p{L}*|une|hutulbur)(?=\s|$)/u;

function socialKind(p: Prepared): SocialKind | null {
  const text = p.norm;
  // "thank u": the "u" is not the question particle "уу".
  const unthanked = prepare(p.raw.replace(/\bthank(?:s)?\s+(?:you|u|ya)\b/giu, "thanks"));
  if (!text || text.length > 900 || asksSomething(unthanked)) return null;
  const withoutFarewell = text.replace(FAREWELL, " ").replace(/\s+/g, " ").trim();
  if ((p.tokens.length > 12 ? REQUEST_FORM : REQUEST_VERB).test(withoutFarewell)) return null;
  const thanked = p.tokens.some((token) => THANKS_TOKEN.test(token));
  const past = PAST_MARK.test(text) || THANKS_FOR.test(text);
  if (thanked) {
    // A short "thanks + a content word" ("Баярлалаа үнэ") may be a telegraphic request; a narrative in the
    // past tense ("Хөтөлбөр нь их сайхан байсан, баярлалаа") is not.
    if (p.tokens.length <= 6 && CONTENT_NOUN.test(text) && !past) return null;
    // A long message is a thank-you only when it is feedback (praise or the past tense); thanks followed by
    // preferences or instructions ("... байхад л болно") may hold something staff must read.
    if (p.tokens.length > 6 && !past && !PRAISE_WORD.test(text)) return null;
    return "thanks";
  }
  if (PRAISE_WORD.test(text) && past) return "praise";
  if (FAREWELL.test(text) && p.tokens.length <= 6) return "farewell";
  const bare = p.tokens.length > 0 && p.tokens.length <= 5 && p.tokens.every((token) => ACK_WORDS.has(token));
  if (bare && p.tokens.some((token) => ACK_CORE.has(token))) return "ack";
  if (CLOSE_PHRASE.test(text) && p.tokens.length <= 8) return "ack";
  return null;
}

/** A bare acknowledgement is only a close when the bot did not just ask the customer something. */
function botAskedSomething(last: string | null | undefined): boolean {
  const value = (last || "").trim();
  // The question mark may sit above a list of options ("Аль өдрөөр аялах вэ?\n• 3/15\n• 3/29"), so the closing
  // 240 characters are read, not just the last one.
  return /[?？]/.test(value.slice(-240)) || /(?:уу|үү|вэ|юу)[\s\p{Extended_Pictographic}️]*$/u.test(value)
    || /(?:бичээрэй|бичнэ\s+үү|хэлнэ\s+үү|сонгоно\s+уу|сонгоорой|илгээнэ\s+үү)[\s.!\p{Extended_Pictographic}️]*$/u.test(value);
}

// ── constraints ──────────────────────────────────────────────────────────────────────────────────

const GENERIC_PLACE_WORDS = new Set(["орон", "хот", "газар", "улс", "тийш", "зүг", "чиглэл", "манай", "бид", "аялах", "явах", "орох"]);
const STOP_BEFORE_DIRECTION = new Set(["манай", "бид", "биднийг", "би", "ойролцоо", "дараа", "нэг"]);

function destinationHints(p: Prepared): string[] {
  const words: string[] = [];
  const direction = /^(?:руу|луу|рүү|ruu+|luu+|rvv+|rүү)$/u;
  const attached = /^(.{3,}?)(?:руу|луу|рүү|ruu+|luu+|rvv+)$/u;
  p.tokens.forEach((token, index) => {
    // "hotruuu" / "хотруу": the direction glued to the word "city"; the place is the word before it.
    const glued = /^(?:(?:hot|хот)(?:r|l)?|r|l)(?:uu+|vv+|үү+|уу+)$/u.test(token);
    if (direction.test(token) || glued) {
      let at = index - 1;
      if (/^(?:hot|хот)$/u.test(p.tokens[at] || "")) at -= 1;
      const candidate = [p.tokens[at - 1], p.tokens[at]].filter((value): value is string => Boolean(value));
      const clean = candidate.filter((value) => !STOP_BEFORE_DIRECTION.has(value) && value.length >= 3 && !/^\d+$/.test(value));
      const last = clean.at(-1);
      if (last && !(clean.length === 1 && GENERIC_PLACE_WORDS.has(last))) words.push(clean.join(" "));
      return;
    }
    const stem = attached.exec(token)?.[1];
    if (stem && stem.length >= 3 && !GENERIC_PLACE_WORDS.has(stem) && !/^\d+$/.test(stem)) words.push(stem);
  });
  return [...new Set(words)].slice(0, 3);
}

/** What the message states, for the staff lead and for choosing the one question to ask. */
export function extractNeedConstraints(text: string): NeedConstraints {
  const p = prepare(text);
  const constraints: NeedConstraints = {};
  const size = headcountIn(text) ?? partySizeIn(p.raw);
  if (size) constraints.groupSize = size;
  const destinations = destinationHints(p);
  if (destinations.length) constraints.destinationWords = destinations;
  const month = /(\d{1,2})\s*(?:-?\s*р\s*)?(?:сар|sar)\p{L}*/u.exec(p.raw);
  if (month && Number(month[1]) >= 1 && Number(month[1]) <= 12) constraints.month = Number(month[1]);
  if (/шинэ\s*жил|shine\s*jil/u.test(p.norm)) constraints.period = "шинэ жил";
  if (/төсөв|tosov|budget|\d\s*сая|₮|mnt/u.test(p.raw)) constraints.budgetMentioned = true;
  return constraints;
}

// ── cue families (also used to validate a model-proposed need against its quoted evidence) ───────

/** A loose test: does this span contain at least one cue of the class? */
export function needCueMatches(need: MessageNeed, span: string, wholeText = span): boolean {
  const p = prepare(span);
  if (!p.norm) return false;
  switch (need) {
    case "social": {
      // A social close asks nothing: a thanks word inside a question is not one.
      const whole = prepare(wholeText);
      if (asksSomething(whole) || REQUEST_VERB.test(whole.norm)) return false;
      return p.tokens.some((token) => THANKS_TOKEN.test(token) || ACK_WORDS.has(token)) || FAREWELL.test(p.norm) || (PRAISE_WORD.test(p.norm) && PAST_MARK.test(p.norm));
    }
    case "business_group": {
      const org = orgHits(p);
      return org.strong || org.weak || CUSTOM_MARKERS.some((pattern) => pattern.test(p.norm)) || QUOTE_CUE.test(p.norm) || (headcountIn(span) ?? 0) >= 10;
    }
    case "commercial_policy":
      return BARTER.test(p.norm) || INVOICE.test(p.norm) || CONTRACT.test(p.norm) || INSTALMENT.test(p.norm) || CARD_PAY.test(p.norm) || DISCOUNT_CUE.test(p.norm);
    case "transport_only":
      return p.tokens.some((token) => TICKET_TOKEN.test(token)) || PICKUP.test(p.norm) || DELIVER.test(p.norm) || HOTEL_ONLY.test(p.norm);
    case "existing_booking":
      return OWN_BOOKING.test(p.norm) || BOOKING_ACTION.test(p.norm) || isBookingStatusQuestion(span);
    case "complaint":
      return COMPLAINT_NOUN.test(p.norm) || COMPLAINT_STRONG.test(p.norm) || (PAST_MARK.test(p.norm) && /муу|муухай/u.test(p.norm));
  }
}

/**
 * Do the owner's own words (the FAQ, special offers and discount policies entered in the admin) already cover the
 * commercial term the customer asked about? Then "no data, no answer" does not apply and the gate steps aside, so
 * the model can answer from that text (and reply.ts guardInventedCommercialClaims checks it against the same text).
 */
export function commercialSignalCovered(signals: readonly string[], ownerText: string): boolean {
  const p = prepare(ownerText);
  if (!p.norm) return false;
  return signals.some((signal) => {
    switch (signal) {
      case "barter": return BARTER.test(p.norm);
      case "invoice": return INVOICE.test(p.norm);
      case "contract": return CONTRACT.test(p.norm);
      case "instalment": return INSTALMENT.test(p.norm);
      case "card": return CARD_PAY.test(p.norm);
      case "group_discount": return DISCOUNT_CUE.test(p.norm);
      default: return false;
    }
  });
}

// ── the classifier ───────────────────────────────────────────────────────────────────────────────

/** An organisation or team of 10+ that wants to travel: this outranks every commercial term it also mentions. */
const ORG_TRAVEL_MAX_TOKENS = 40;

function organisedGroup(p: Prepared, size: number | null): string[] | null {
  const org = orgHits(p);
  if (org.strong) {
    if (size !== null && size >= 10) return ["org", `headcount:${size}`];
    // A pasted advertisement or a long story that merely contains an organisation word is not an organisation asking.
    if (TRAVEL_CUE.test(p.norm) && p.tokens.length <= ORG_TRAVEL_MAX_TOKENS) return ["org", "travel"];
  }
  if (org.weak && size !== null && size >= 10) return ["weak_org", `headcount:${size}`];
  return null;
}

/** Looser group / bespoke shapes, tried after the commercial terms (a bare "бартер" is not a trip request). */
function bespokeTravel(p: Prepared): string[] | null {
  const org = orgHits(p);
  if (org.strong) {
    if (DISCOUNT_CUE.test(p.norm) && p.tokens.length <= ORG_TRAVEL_MAX_TOKENS) return ["org", "discount"];
    if (p.tokens.length <= 3 && !asksSomething(p)) return ["org", "org_only"];
  }
  const services = SERVICE_FAMILIES.filter((pattern) => pattern.test(p.norm)).length;
  const custom = CUSTOM_MARKERS.find((pattern) => pattern.test(p.norm));
  if (custom) {
    // "тусгай маршрут", "хөтөлбөрт хамрагдахгүй" are bespoke asks on their own; "багцгүй" / "тус тусад нь"
    // need the itemised services to mean a quote.
    if (/багцгүй|багцаас\s+гадуур|тус\s+тусад\s+нь/u.test(p.norm) && services < 2) return null;
    return ["custom"];
  }
  if (services >= 3 && p.norm.length >= 80 && QUOTE_CUE.test(p.norm) && !INCLUDED_QUESTION.test(p.norm)) return ["itemised_quote"];
  return null;
}

function commercialPolicy(p: Prepared, size: number | null): string[] | null {
  const signals: string[] = [];
  if (BARTER.test(p.norm)) signals.push("barter");
  if (INVOICE.test(p.norm)) signals.push("invoice");
  if (CONTRACT.test(p.norm) && CONTRACT_CONTEXT.test(p.norm)) signals.push("contract");
  if (INSTALMENT.test(p.norm) && PAY_CUE.test(p.norm)) signals.push("instalment");
  if (CARD_PAY.test(p.norm)) signals.push("card");
  if (!signals.length && DISCOUNT_CUE.test(p.norm) && (GROUP_WORD.test(p.norm) || (size !== null && size >= 10)) && !orgHits(p).strong) signals.push("group_discount");
  return signals.length ? signals : null;
}

function transportOnly(p: Prepared): string[] | null {
  if (INCLUDED_QUESTION.test(p.norm)) return null;
  const hasTicket = p.tokens.some((token) => TICKET_TOKEN.test(token));
  if (hasTicket && TICKET_ONLY_MARK.test(p.norm)) return ["ticket_only"];
  if (PICKUP.test(p.norm) && (MOVEMENT.test(p.norm) || /боломж|bolomj/u.test(p.norm)) && !/хэд/u.test(p.norm)) return ["pickup"];
  if (DELIVER.test(p.norm) && MOVEMENT.test(p.norm)) return ["transfer"];
  if (HOTEL_ONLY.test(p.norm) && !/аялал|хөтөлбөр|багц/u.test(p.norm)) return ["hotel_only"];
  return null;
}

function existingBooking(p: Prepared, text: string): string[] | null {
  if (OWN_BOOKING.test(p.norm) && BOOKING_ACTION.test(p.norm)) return ["own_booking", "action"];
  if (isBookingStatusQuestion(text)) return ["status_question"];
  return null;
}

function complaint(p: Prepared): string[] | null {
  if (COMPLAINT_NOUN.test(p.norm)) return ["complaint_word"];
  if (COMPLAINT_STRONG.test(p.norm) && !asksSomething(p)) return ["negative_experience"];
  if (/муу|муухай/u.test(p.norm) && PAST_MARK.test(p.norm) && SERVICE_NOUN.test(p.norm) && !asksSomething(p)) return ["past_bad_service"];
  return null;
}

/** Does this message answer the group-inquiry question the bot just asked (a place, a month, a head count)? */
function looksLikeInquiryAnswer(p: Prepared): boolean {
  return p.tokens.length > 0 && p.tokens.length <= 12 && !asksSomething(p) && !REQUEST_VERB.test(p.norm);
}

/**
 * Names what the customer needs, or null when this is an ordinary trip question (or anything the
 * existing pipeline already handles). Order matters: a complaint or a booking already made outranks
 * a commercial term, which outranks a group, which outranks a ticket-only wish, which outranks thanks.
 */
export function classifyMessageNeed(text: string, context: NeedContext = {}): MessageNeedResult | null {
  const p = prepare(text);
  if (!p.norm || p.raw.length > 2000) return null;
  const size = headcountIn(text);
  const finish = (need: MessageNeed, signals: string[], social?: SocialKind): MessageNeedResult =>
    ({ need, signals, constraints: extractNeedConstraints(text), ...(social ? { social } : {}) });

  const complained = complaint(p);
  if (complained) return finish("complaint", complained);
  const booked = existingBooking(p, text);
  if (booked) return finish("existing_booking", booked);
  const organised = organisedGroup(p, size);
  if (organised) return finish("business_group", organised);
  const commercial = commercialPolicy(p, size);
  if (commercial) return finish("commercial_policy", commercial);
  const bespoke = bespokeTravel(p);
  if (bespoke) return finish("business_group", bespoke);
  const transport = transportOnly(p);
  if (transport) return finish("transport_only", transport);
  const social = socialKind(p) ?? (isThanksOnly(text) ? "thanks" : null);
  if (social) {
    // "ok" right after a question from the bot may be the answer to it: leave it to the pipeline.
    if (social === "ack" && botAskedSomething(context.lastBotReply)) return null;
    return finish("social", [`social:${social}`], social);
  }
  if (isGroupInquiryReply(context.lastBotReply) && looksLikeInquiryAnswer(p)) return finish("business_group", ["inquiry_answer"]);
  return null;
}

/** Thanks, praise, an acknowledgement or a farewell: nothing to look up, nothing for staff to do. */
export function isSocialMessage(text: string): boolean {
  if (isThanksOnly(text)) return true;
  const p = prepare(text);
  return !complaint(p) && !existingBooking(p, text) && socialKind(p) !== null;
}

/** The social kind of a message the model called social; an unclear one is treated as a bare acknowledgement (silence). */
export function socialKindOfText(text: string): SocialKind {
  return socialKind(prepare(text)) ?? (isThanksOnly(text) ? "thanks" : "ack");
}
