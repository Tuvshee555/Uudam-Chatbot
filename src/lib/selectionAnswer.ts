/**
 * "1" / "2." / "2-р" answering the bot's own bulleted selection question
 * ("Аль буудлын хувилбарыг сонгох вэ? • A • B"). The options are bullets, not numbers, but a
 * customer reads them as a list and answers with the position; the bare number used to
 * reach the "no open list" branch, which hands the customer to staff and pauses the bot.
 * The number becomes the option's own words, so the normal flow reads it like a typed answer.
 */

const SELECTION_QUESTION = /Аль\s+(?:гарах\s+өдрөөр\s+аялах|буудлын\s+хувилбарыг\s+сонгох|багцыг\s+сонгох)\s+вэ\?/u;
const NUMBER_ONLY = /^\s*(\d{1,2})\s*(?:[.)]|-?\s*(?:р|дугаар|дахь))?\s*$/iu;

/** The options a selection question listed, in order, without the "Өөр N сонголт бий" footer. */
export function selectionOptions(reply: string): string[] {
  const question = SELECTION_QUESTION.exec(reply);
  if (!question) return [];
  return reply.slice(question.index + question[0].length)
    .split(/(?:^|\n|\s)•\s+/u).slice(1)
    .map((option) => (option.split("\n")[0] || "").trim())
    .filter((option) => option && !/^Өөр\s+\d+\s+сонголт/iu.test(option));
}

/** The option the customer's bare number picks from the last reply, or null. */
export function optionChosenByNumber(history: Array<{ role: string; text: string }>, text: string): string | null {
  const picked = NUMBER_ONLY.exec(text);
  if (!picked) return null;
  const last = history.findLast((message) => message.role === "assistant");
  if (!last) return null;
  return selectionOptions(last.text)[Number(picked[1]) - 1] ?? null;
}
