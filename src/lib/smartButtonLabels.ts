/**
 * The bot's own quick-reply labels.
 *
 * A dependency-free leaf module so fastPathRouting.ts can recognise them
 * without importing travelFastPaths.ts (which imports the router's own
 * neighbours — a cycle).
 *
 * These are UI chrome, not customer prose: when a customer taps one, the
 * text that arrives is OURS. Several collide with real trip names in the
 * live catalog — "Хөтөлбөр үзэх" contains "хөтөлбөр" (two "…аяллын
 * хөтөлбөр" trips) and "үзэх" ("Ордос -намрын тахилга үзэх аялал") — so the
 * name matcher would "verify" one of those from the bare label. The router
 * treats them as carrying no trip identity and resolves from conversation
 * context instead.
 */
export const SMART_BUTTON_LABELS = {
  PROGRAM: "Хөтөлбөр үзэх",
  PHOTOS: "Зураг үзэх",
  BOOK: "Захиалах",
  SEATS: "Суудал бий юу?",
} as const;

export const SMART_BUTTON_LABEL_LIST: string[] = Object.values(SMART_BUTTON_LABELS);
