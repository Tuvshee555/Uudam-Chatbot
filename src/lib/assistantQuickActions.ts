import type { AIChangeProposal, TravelTrip } from "./travelTypes";

export type QuickActionKind = "cancel" | "seats" | "food";

export type QuickActionRequest = {
  kind: QuickActionKind;
  trip_id: string;
  /** seats: the new number of free seats; food: true when meals are included. */
  value?: number | boolean;
};

type Built = { ok: true; proposal: AIChangeProposal } | { ok: false; message: string };

/**
 * A change the admin picked from a button is exact: the trip comes from a list
 * and the value from a field, so code builds the proposal and the AI is never
 * asked to guess which trip or which number was meant. It goes through the
 * same review, apply and rollback path as every AI proposal.
 */
export function buildQuickProposal(trip: TravelTrip, request: QuickActionRequest): Built {
  const name = trip.route_name;
  const base = { needs_confirmation: true, conflicts: [] as string[], conflict_items: [] };
  if (request.kind === "cancel") {
    if (trip.status === "cancelled") return { ok: false, message: `«${name}» аялал аль хэдийн цуцлагдсан байна.` };
    return { ok: true, proposal: { ...base,
      summary: `«${name}» аяллыг цуцлах.`,
      important_reason: "Цуцалсан аялал сайт болон ботоос харагдахаа болино. Хэрэгтэй бол буцааж болно.",
      actions: [{ action: "cancel", trip_id: trip.id }],
    } };
  }
  if (request.kind === "seats") {
    const seats = request.value;
    if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 0 || seats > 1000) {
      return { ok: false, message: "Суудлын тоо 0-ээс 1000 хүртэлх бүхэл тоо байх ёстой." };
    }
    return { ok: true, proposal: { ...base,
      summary: `«${name}» — үлдсэн суудал ${trip.seats_left ?? "тодорхойгүй"} → ${seats}.`,
      important_reason: seats === 0 ? "0 суудал бол энэ аялал дүүрсэн гэж харагдана." : "",
      actions: [{ action: "patch", trip_id: trip.id, fields: { seats_left: seats } }],
    } };
  }
  if (request.kind === "food") {
    if (typeof request.value !== "boolean") return { ok: false, message: "Хоолтой эсэхийг сонгоно уу." };
    return { ok: true, proposal: { ...base,
      summary: `«${name}» — хоол ${trip.has_food ? "багтсан" : "багтаагүй"} → ${request.value ? "багтсан" : "багтаагүй"}.`,
      important_reason: "",
      actions: [{ action: "patch", trip_id: trip.id, fields: { has_food: request.value } }],
    } };
  }
  return { ok: false, message: "Тодорхойгүй үйлдэл." };
}

export async function createQuickProposal(request: QuickActionRequest): Promise<
  { ok: true; proposal: AIChangeProposal; request_id: number | null } | { ok: false; message: string }
> {
  // Loaded on use: the database layer validates the server environment at import.
  const [{ queryNeon }, { ensureTravelSchema }, { getTripById }] = await Promise.all([
    import("./neonDb"), import("./travelSchema"), import("./travelDb"),
  ]);
  if (!(await ensureTravelSchema())) return { ok: false, message: "Өгөгдлийн сан холбогдоогүй байна." };
  const trip = await getTripById(String(request.trip_id || ""));
  if (!trip) return { ok: false, message: "Аялал олдсонгүй. Жагсаалтаа шинэчлээд дахин сонгоно уу." };
  const built = buildQuickProposal(trip, request);
  if (!built.ok) return built;
  let requestId: number | null = null;
  try {
    const inserted = await queryNeon<{ id: number }>(
      `INSERT INTO travel_ai_change_requests (instruction, proposal_json, conflicts, needs_confirmation, status)
       VALUES ($1, $2::jsonb, $3::text[], TRUE, 'pending') RETURNING id`,
      [`[Товч үйлдэл] ${built.proposal.summary}`, JSON.stringify(built.proposal), []],
    );
    requestId = inserted?.rows?.[0]?.id ?? null;
  } catch {
    // The proposal can still be applied directly from the page.
  }
  return { ok: true, proposal: built.proposal, request_id: requestId };
}
