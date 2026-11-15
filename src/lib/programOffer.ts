/**
 * A typed "yes" under the follow-up's programme offer ("Аяллын дэлгэрэнгүй хөтөлбөрийг авах уу?") is the
 * «Хөтөлбөр үзэх» button: the customer gets the programme of the trip in play, through the same path as a tap.
 * Without this a bare "тийм" / "за" under the offer is an acknowledgement and the customer gets nothing.
 *
 * Only directly under the offer (the bot's last message), and only a short yes: anything longer is read as
 * the customer wrote it.
 */
import { endsWithProgramOffer } from "./nextQuestionText";
import { SMART_BUTTON_LABELS } from "./smartButtonLabels";

const YES = /^(?:тийм(?:ээ)?|тиимээ|тийм\s+ээ|за+(?:\s+за+)?|за\s+(?:тэгье|авъя|авья|болно|илгээгээрэй|явуулаарай)|тэгье|тэгээрэй|авъя|авья|авна|авмаар\s+байна|болно|болж\s+байна|хүсэж\s+байна|илгээгээрэй|илгээнэ\s+үү|явуулаарай|явуулаач|явуулна\s+уу|ok|ок|окей|okey|okay|yes|ys|tiim(?:ee)?|tiimee|za+|tegye|avya|avii|avy|bolno|yawuulaarai|yavuulaarai|ilgeegeerei)[\s!.…😊🙏👍❤️]*$/iu;

export function isProgramOfferYes(text: string): boolean {
  return YES.test(text.trim());
}

/** The button label to route instead of the customer's "yes", or null. */
export function programOfferAccepted(history: Array<{ role: string; text: string }>, text: string): string | null {
  const last = history.at(-1);
  if (!last || last.role !== "assistant" || !endsWithProgramOffer(last.text)) return null;
  return isProgramOfferYes(text) ? SMART_BUTTON_LABELS.PROGRAM : null;
}
