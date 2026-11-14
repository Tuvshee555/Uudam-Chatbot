/**
 * The single most useful thing to ask next (owner, 2026-11-12): "the chatbot was not asking questions /
 * not doing follow-up. It should ask, depending on the conversation: what kind of trip, how many of you
 * are going, when, what is your budget — basic ones." In the 10 days before, 42 of the 59 threads that
 * ended on a bot reply ended on one that asked nothing (a bare programme link, "<date>: захиалга
 * нээлттэй.", a fare card with no next step).
 *
 * Deterministic, no model call. One question at a time, in the customer's order: where and when →
 * which of the shown trips → which departure → how many people → budget (only while browsing broadly)
 * → hand the booking to a consultant. Never a slot the customer already gave, never the question the
 * bot asked in its previous message (or in the reply itself), and no facts (no trip names, prices or
 * dates), so the reply checker and the grounding exit never see anything new.
 *
 * Used twice: appended to a trip answer that ends without a question (replyQuestion in followUp.ts),
 * and as the one follow-up message when the customer leaves the answer on seen (runFollowUpSweep).
 */
import { BOOKING_WEBSITE_URL, publishedTripWebsiteLink } from "./bookingWebsite";
import type { ConstraintLedger } from "./constraintLedger";
import { withBookableDepartureDates } from "./departureAvailability";
import { FOLLOW_UP_ALL_TRIPS_WEB_LINE, FOLLOW_UP_TRIP_WEB_LINE, NEXT_QUESTION_BUDGET, NEXT_QUESTION_DATE, NEXT_QUESTION_DESTINATION,
  NEXT_QUESTION_NEXT_STEP, NEXT_QUESTION_PARTY, NEXT_QUESTION_PICK, NEXT_QUESTION_PICK_UNNUMBERED, NEXT_QUESTION_PROGRAM,
  NEXT_QUESTION_WHEN, PARTY_AND_PHONE_INVITE, PHONE_INVITE } from "./nextQuestionText";
import { upcomingDepartures } from "./tripFareBlock";
import type { TripSelection } from "./tripRequest";
import type { TravelTrip } from "./travelTypes";

// The wording lives in nextQuestionText.ts (the owner may reword it there).
export { NEXT_QUESTION_BUDGET, NEXT_QUESTION_DATE, NEXT_QUESTION_DESTINATION, NEXT_QUESTION_NEXT_STEP, NEXT_QUESTION_PARTY,
  NEXT_QUESTION_PICK, NEXT_QUESTION_PICK_UNNUMBERED, NEXT_QUESTION_WHEN };

export type NextQuestionSlot = "destination" | "when" | "pick" | "date" | "party" | "budget" | "next_step" | "program";

const TEXT: Record<Exclude<NextQuestionSlot, "pick">, string> = {
  destination: NEXT_QUESTION_DESTINATION, when: NEXT_QUESTION_WHEN, date: NEXT_QUESTION_DATE,
  party: NEXT_QUESTION_PARTY, budget: NEXT_QUESTION_BUDGET, next_step: NEXT_QUESTION_NEXT_STEP, program: NEXT_QUESTION_PROGRAM,
};

/** The programme PDF already went out (programme fast path) in this conversation. */
const PROGRAM_SENT = /хөтөлбөрийг\s+хавсаргалаа/iu;
/** A website link the bot already showed: not repeated in the follow-up. */
const TRIP_LINK_SHOWN = /uudamtravel\.mn\/(?:mn\/|en\/|ko\/)?trips\//iu;
const SITE_SHOWN = /uudamtravel\.mn/iu;

export type NextQuestion = { slot: NextQuestionSlot; text: string };

export type NextQuestionInput = {
  /** "reply": a question added to the answer being sent; "follow_up": the message after silence. */
  purpose: "reply" | "follow_up";
  /** The answer being sent (reply) or the one the customer left on seen (follow_up). */
  reply: string;
  /** The bot's message before `reply`, if any. */
  previousBotText?: string | null;
  /** Conversation so far (the customer's messages are read for slots they already gave). */
  history: Array<{ role: string; text: string }>;
  /** The customer's message `reply` answers. */
  customerText: string;
  selection: TripSelection | null;
  /** The trips of the list the bot offered (clarification state). */
  pendingTripIds: string[];
  ledger: ConstraintLedger | null;
  /** The customer-visible catalogue (for the departures of the trip in play). */
  trips: TravelTrip[];
  /** A phone number is already in the conversation. */
  phoneKnown: boolean;
  now?: Date;
};

// Which slot a bot message already asks, read only from its question sentences: "Ойрын гарах өдрүүд:"
// above a date list is not a question about the date.
const ASKS: Array<[NextQuestionSlot, RegExp]> = [
  ["destination", /(?:ямар|аль)\s+(?:\p{L}+\s+)?(?:чиглэл|аялал(?!\p{L})|аяллын\s+талаар)/iu],
  ["when", /хэдэн\s+сар|аль\s+сар|хэзээ\s+(?:аялах|явах)/iu],
  ["pick", /аль\s+(?:аялл|нь)|дугаараар|гэж\s+бичээрэй|аль\s+аялал/iu],
  ["date", /аль\s+(?:гарах\s+)?өдөр|(?:гарах\s+)?өдр(?:ийг|өөр)\s+(?:сонирх|сонго|аял|яв)|ямар\s+өдөр/iu],
  ["party", /хэдэн\s+хүн|хэдүүлээ|хүүхэд\s+байвал|насыг\s+нь|хэдэн\s+том/iu],
  ["budget", /төсөв/iu],
  ["next_step", /утасны\s+дугаар|дугаараа\s+(?:үлдээ|бич)/iu],
  ["program", /хөтөлбөрийг\s+(?:нь\s+)?(?:авах|илгээх|явуулах)\s+уу/iu],
];
const QUESTION_SEGMENT = /[?？]|бичээрэй|бичнэ\s+үү|үлдээгээрэй|сонгоорой|(?:^|\s)(?:вэ|бэ|уу|үү)\s*[.!😊🙏]*$/iu;

/** The slots a bot message asks about. */
export function askedSlots(text: string | null | undefined): Set<NextQuestionSlot> {
  const asked = new Set<NextQuestionSlot>();
  for (const segment of String(text || "").split(/\n|(?<=[?？.!])\s+/)) {
    if (!QUESTION_SEGMENT.test(segment.trim())) continue;
    for (const [slot, pattern] of ASKS) if (pattern.test(segment)) asked.add(slot);
  }
  return asked;
}

// What the customer already said, in their own words (the selection and ledger hold the rest).
const PARTY_WORDS = /\d+\s*(?:том|хүүхэд|хүүхдүүд|хүн|нярай|настай|tom|huuhed|hun|nas)|том\s*хүн|хүүхэд|хүүхдүүд|нярай|гэр\s*бүл|ганцаараа|хоёулаа|гурвуулаа|дөрвүүлээ|хосоороо|tom\s*hun|huuhed|ger\s*bul/iu;
const WHEN_WORDS = /\d{1,2}\s*(?:-?\s*р\s*)?сар|\d{1,2}\s*[./]\s*\d{1,2}|сарын|шинэ\s*жил|цагаан\s*сар|наадам|ирэх\s*(?:сар|долоо|жил)|\d{1,2}\s*-?\s*(?:r\s*)?sar|sariin|sarin|saryn/iu;
const BUDGET_WORDS = /төсөв|tusuv|сая(?!\p{L})|\d[\d,. ]{4,}\s*(?:₮|төг|tug)/iu;

function customerSaid(input: NextQuestionInput, pattern: RegExp): boolean {
  const own = input.history.filter((message) => message.role === "user").slice(-12).map((message) => message.text);
  return [...own, input.customerText].some((text) => pattern.test(text || ""));
}

/** List lines of a reply ("1. …", "• …"): a reply showing several trips to choose from. */
function listLines(reply: string): { numbered: number; bulleted: number } {
  return { numbered: (reply.match(/^\s*\d{1,2}[.)]\s+\S/gmu) || []).length, bulleted: (reply.match(/^\s*[•▪◦-]\s+\S/gmu) || []).length };
}

/** Bookable departures of the trip in play, inside the customer's window when they gave one. */
function openDepartures(trip: TravelTrip, selection: TripSelection, now: Date): string[] {
  const dates = upcomingDepartures(withBookableDepartureDates(trip, now), now);
  const scope = selection.dateScope;
  if (!scope) return dates;
  const inside = dates.filter((date) => (!scope.month || Number(date.slice(5, 7)) === scope.month)
    && (!scope.year || Number(date.slice(0, 4)) === scope.year)
    && (!scope.range || (date >= scope.range[0] && date <= scope.range[1]))
    && (!scope.dates || scope.dates.includes(date)));
  return inside.length ? inside : dates;
}

/** The one question to ask next, or null when there is nothing worth asking. */
export function nextQuestion(input: NextQuestionInput): NextQuestion | null {
  const now = input.now ?? new Date();
  const asked = new Set([...askedSlots(input.previousBotText), ...askedSlots(input.reply)]);
  const ledger = input.ledger;
  const partyKnown = Boolean(input.selection?.passengers.length || ledger?.passengers.length || ledger?.groupSize)
    || customerSaid(input, PARTY_WORDS);
  const whenKnown = Boolean(input.selection?.date || input.selection?.dateScope || ledger?.dateScope) || customerSaid(input, WHEN_WORDS);
  const budgetKnown = customerSaid(input, BUDGET_WORDS);
  const priceInPlay = /₮|төгрөг/u.test(`${input.reply}\n${input.previousBotText || ""}`);
  const candidates: NextQuestion[] = [];
  const lines = listLines(input.reply);
  const selected = input.selection ? input.trips.find((trip) => trip.id === input.selection!.tripId) || null : null;
  const botTexts = [...input.history.filter((message) => message.role === "assistant").map((message) => message.text), input.reply].join("\n");

  if (input.pendingTripIds.length >= 2 && lines.numbered + lines.bulleted >= 2) {
    // (b) A list is on screen and nothing is chosen from it yet.
    candidates.push({ slot: "pick", text: lines.numbered >= 2 ? NEXT_QUESTION_PICK : NEXT_QUESTION_PICK_UNNUMBERED });
    if (!partyKnown) candidates.push({ slot: "party", text: TEXT.party });
  } else if (selected) {
    // A trip that cannot be booked (full, paused, ended) is not sold any further by a question.
    if (selected.status !== "active") return null;
    const departures = openDepartures(selected, input.selection!, now);
    const dateSettled = Boolean(input.selection!.date) || departures.length <= 1;
    // After silence, a consultant's first move: offer the full programme of the trip in play (with its web page),
    // unless the programme PDF already went out.
    if (input.purpose === "follow_up" && !PROGRAM_SENT.test(botTexts)) candidates.push({ slot: "program", text: TEXT.program });
    // (c) one trip, several open departures, none chosen; (d) the party; (f) the consultant — in an
    // answer only once trip, date and party are known; after silence also as the last thing to offer
    // when the bot's own question went unanswered.
    if (!dateSettled) candidates.push({ slot: "date", text: TEXT.date });
    if (!partyKnown) candidates.push({ slot: "party", text: TEXT.party });
    if (!input.phoneKnown && ((partyKnown && dateSettled) || input.purpose === "follow_up")) {
      candidates.push({ slot: "next_step", text: TEXT.next_step });
    }
  } else if (!input.selection) {
    // (a) Nothing in play yet: where and when. (e) Browsing with the party known: the budget.
    const destinationKnown = Boolean(ledger?.destinations.length);
    if (!destinationKnown) candidates.push({ slot: "destination", text: TEXT.destination });
    else if (!whenKnown) candidates.push({ slot: "when", text: TEXT.when });
    if (partyKnown && !priceInPlay && !budgetKnown) candidates.push({ slot: "budget", text: TEXT.budget });
  }
  const chosen = candidates.find((candidate) => !asked.has(candidate.slot)
    // The destination question also asks the month: not after the bot just asked either.
    && !(candidate.slot === "destination" && asked.has("when"))) ?? null;
  return chosen && input.purpose === "follow_up" ? withWebsiteLine(chosen, selected, botTexts) : chosen;
}

/**
 * The follow-up carries the website (owner, 2026-11-13: "or sends web with it"): the trip's own page for the
 * programme offer, the site for "which trip / where / when", once — never when the bot already showed it. The
 * link goes ABOVE the question, so the message still ends with (and is recognised as) that question.
 */
function withWebsiteLine(question: NextQuestion, selected: TravelTrip | null, botTexts: string): NextQuestion {
  if (question.slot === "program") {
    const link = selected ? publishedTripWebsiteLink(selected) : null;
    return link && !TRIP_LINK_SHOWN.test(botTexts) ? { ...question, text: `${FOLLOW_UP_TRIP_WEB_LINE} ${link}\n${question.text}` } : question;
  }
  if (["destination", "when", "pick"].includes(question.slot) && !SITE_SHOWN.test(botTexts)) {
    return { ...question, text: `${FOLLOW_UP_ALL_TRIPS_WEB_LINE} ${BOOKING_WEBSITE_URL}\n${question.text}` };
  }
  return question;
}

/**
 * The phone ask added to a trip answer beside its own question (owner, 2026-11-14: "ask more questions … wanted
 * numbers most: how many are going …"). From the first trip answer (most customers who leave do so after it), never
 * when a phone is already known, and never when the bot asked for the phone in this reply or its last two
 * messages, so at most every third message asks. With the party unknown and not being asked, one line asks both.
 */
export function phoneInvite(input: NextQuestionInput, appended: NextQuestion | null): NextQuestion | null {
  if (input.purpose !== "reply" || input.phoneKnown) return null;
  const botMessages = input.history.filter((message) => message.role === "assistant");
  const recent = [...botMessages.slice(-2).map((message) => message.text), input.reply, appended?.text ?? ""];
  if (recent.some((text) => askedSlots(text).has("next_step") || /утасны\s+дугаар/iu.test(text))) return null;
  const partyKnown = Boolean(input.selection?.passengers.length || input.ledger?.passengers.length || input.ledger?.groupSize)
    || customerSaid(input, PARTY_WORDS);
  const partyAsked = appended?.slot === "party" || askedSlots(input.reply).has("party");
  return { slot: "next_step", text: partyKnown || partyAsked ? PHONE_INVITE : PARTY_AND_PHONE_INVITE };
}

/** A reply that already asks the customer something (any "?" counts, as the owner put it). */
export function replyAsksSomething(reply: string): boolean {
  return /[?？]/u.test(reply);
}

const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const LEADING_ICONS = /^\s*(?:\p{Extended_Pictographic}️?\s*)+/u;

/**
 * The reply with the question after one blank line. An icon that opens a line is layout; the reply
 * policy allows one emoji inside the text, so the question drops its own when the reply has one.
 */
export function appendNextQuestion(reply: string, question: NextQuestion): string {
  const body = reply.replace(/\s+$/u, "");
  const inlineEmoji = body.split("\n").some((line) => PICTOGRAPH.test(line.replace(LEADING_ICONS, "")));
  const text = inlineEmoji ? question.text.replace(/\s*\p{Extended_Pictographic}️?\s*$/u, "") : question.text;
  return `${body}\n\n${text}`;
}
