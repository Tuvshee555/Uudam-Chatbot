/**
 * The wording of the bot's next questions (nextQuestion.ts) in one place, with no imports, so any
 * module can recognise them. The owner may reword these; keep each short, factless (no trip name,
 * price or date) and ending in a question or a clear ask.
 */
export const NEXT_QUESTION_DESTINATION = "Ямар чиглэлд, хэдэн сард аялахаар төлөвлөж байна вэ? 😊";
export const NEXT_QUESTION_WHEN = "Хэдэн сард аялахаар төлөвлөж байна вэ? 😊";
export const NEXT_QUESTION_PICK = "Эдгээрээс аль нь танд илүү таалагдаж байна вэ? Дугаараар нь бичихэд болно 😊";
/** The same ask under a list without numbers (informational alternatives). */
export const NEXT_QUESTION_PICK_UNNUMBERED = "Эдгээрээс аль нь танд илүү таалагдаж байна вэ? 😊";
export const NEXT_QUESTION_DATE = "Аль өдөр нь танд тохирох вэ?";
export const NEXT_QUESTION_PARTY = "Хэдэн хүн явах вэ? Хүүхэд байвал насыг нь бичээрэй 😊";
export const NEXT_QUESTION_BUDGET = "Нэг хүнд ойролцоогоор ямар төсөв төлөвлөж байна вэ?";
export const NEXT_QUESTION_NEXT_STEP = "Захиалах бол утасны дугаараа үлдээгээрэй, манай аяллын зөвлөх тантай холбогдоно 😊";
/**
 * The follow-up after silence while one trip is in play (owner, 2026-11-13: "when someone doesn't answer for
 * 30 minutes send 'хөтөлбөр авах уу' or send the web with it"). Sent with the «Хөтөлбөр үзэх» button; a typed
 * "тийм" / "за" under it is that button (programOffer.ts).
 */
export const NEXT_QUESTION_PROGRAM = "Аяллын дэлгэрэнгүй хөтөлбөрийг авах уу? 😊";
/** The line above a follow-up that carries a website link (the question stays last, so it is still recognised). */
export const FOLLOW_UP_TRIP_WEB_LINE = "Аяллын мэдээлэл, зургийг вэбээс ч харж болно:";
export const FOLLOW_UP_ALL_TRIPS_WEB_LINE = "Бүх аяллыг эндээс харж болно:";

export const NEXT_QUESTION_TEXTS: readonly string[] = [NEXT_QUESTION_DESTINATION, NEXT_QUESTION_WHEN, NEXT_QUESTION_PICK,
  NEXT_QUESTION_PICK_UNNUMBERED, NEXT_QUESTION_DATE, NEXT_QUESTION_PARTY, NEXT_QUESTION_BUDGET, NEXT_QUESTION_NEXT_STEP,
  NEXT_QUESTION_PROGRAM];

/** The last line of a message is the programme offer (with or without its emoji). */
export function endsWithProgramOffer(text: string | null | undefined): boolean {
  const last = String(text || "").trim().split("\n").at(-1)?.trim() ?? "";
  return last === NEXT_QUESTION_PROGRAM || last === withoutEmoji(NEXT_QUESTION_PROGRAM);
}

const withoutEmoji = (text: string) => text.replace(/\s*\p{Extended_Pictographic}️?\s*$/u, "");

/** Is this message (or line) exactly one of the next questions, with or without its emoji? */
export function isNextQuestionText(text: string): boolean {
  // A follow-up may carry one website line above its question: it is still that question.
  const lines = text.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const value = lines.length === 2 && [FOLLOW_UP_TRIP_WEB_LINE, FOLLOW_UP_ALL_TRIPS_WEB_LINE].some((prefix) => lines[0].startsWith(prefix))
    ? lines[1] : text.trim();
  return NEXT_QUESTION_TEXTS.some((question) => value === question || value === withoutEmoji(question));
}

/**
 * The bot's message without a next question added at its end. These are open questions ("how many
 * people?"): an "ok" under one is not its answer, so the need gate reads the answer before it.
 */
export function withoutNextQuestion(text: string): string {
  const value = (text || "").trimEnd();
  for (const question of NEXT_QUESTION_TEXTS) {
    for (const form of [question, withoutEmoji(question)]) {
      if (value.endsWith(form)) return value.slice(0, value.length - form.length).trimEnd();
    }
  }
  return value;
}
