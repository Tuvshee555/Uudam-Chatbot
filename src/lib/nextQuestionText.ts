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

export const NEXT_QUESTION_TEXTS: readonly string[] = [NEXT_QUESTION_DESTINATION, NEXT_QUESTION_WHEN, NEXT_QUESTION_PICK,
  NEXT_QUESTION_PICK_UNNUMBERED, NEXT_QUESTION_DATE, NEXT_QUESTION_PARTY, NEXT_QUESTION_BUDGET, NEXT_QUESTION_NEXT_STEP];

const withoutEmoji = (text: string) => text.replace(/\s*\p{Extended_Pictographic}️?\s*$/u, "");

/** Is this message (or line) exactly one of the next questions, with or without its emoji? */
export function isNextQuestionText(text: string): boolean {
  const value = text.trim();
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
