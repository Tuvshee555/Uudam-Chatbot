type ItineraryDayLike = {
  title?: unknown;
  description?: unknown;
};

const ULAANBAATAR = /улаанба+тар|улаан\s*баатар|(?:^|\s|[-–—→])уб(?=$|\s|[-–—→])|chinggis\s*khaan|чингис\s*хаан/i;
const OUTBOUND_TRAVEL = /нис|хөөр|х[өо]д|мордох|яв|зорин|гарна|сууж|суугаад|оч|departure|depart/i;
const RETURN_TRAVEL = /буц|ир|хүрэлцэн|бууж|газар|өндөрл|дуус|эх орон|хөөр|return|arriv|land/i;

function value(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasUlaanbaatar(value: string): boolean {
  return ULAANBAATAR.test(value);
}

export function itineraryStartsInUlaanbaatar(day: ItineraryDayLike | undefined): boolean {
  if (!day) return false;
  const title = value(day.title);
  const description = value(day.description);
  return hasUlaanbaatar(`${title} ${description}`) && OUTBOUND_TRAVEL.test(description);
}

export function itineraryEndsInUlaanbaatar(day: ItineraryDayLike | undefined): boolean {
  if (!day) return false;
  const title = value(day.title);
  const description = value(day.description);
  const explicitArrival = hasUlaanbaatar(description) && RETURN_TRAVEL.test(description);
  const homewardArrival = hasUlaanbaatar(title) && /эх орон|home/i.test(description) && RETURN_TRAVEL.test(description);
  return explicitArrival || homewardArrival;
}
