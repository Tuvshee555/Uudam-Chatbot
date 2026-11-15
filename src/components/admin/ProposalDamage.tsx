/**
 * The red notice at the top of a proposal card when a change would break a saved trip (its name
 * replaced, the trip off the website, its prices or program gone — src/lib/tripDamage.ts). Save
 * stays off until the admin ticks that he means it; the tick travels with the saved proposal
 * (`acknowledged_damage`) and the server checks it again against the trip as it is at save time.
 *
 * Why (2026-11-14): a new-trip review card also carried a change that renamed a live trip and
 * emptied its dates. The change sat below the new trip's review, it was saved, and the trip left
 * the website without anyone seeing it.
 */
import { Icons } from "@/components/ui";
import type { AIProposal } from "@/lib/adminTypes";

export type DamagedAction = { index: number; name: string; lines: string[]; kinds: string[] };

/** Every action of the card that would break a saved trip, with that trip's name. */
export function damagedActions(proposal: AIProposal, nameOf: (index: number) => string): DamagedAction[] {
  return proposal.actions.flatMap((action, index) => {
    const damage = Array.isArray(action.damage) ? action.damage.filter((item) => item && typeof item.text === "string") : [];
    return damage.length ? [{ index, name: nameOf(index), lines: damage.map((item) => item.text), kinds: damage.map((item) => String(item.kind)) }] : [];
  });
}

/** The proposal as saved after the tick: each damaged action carries the kinds the admin accepted. */
export function withAcknowledgedDamage(proposal: AIProposal): AIProposal {
  return {
    ...proposal,
    actions: proposal.actions.map((action) => (Array.isArray(action.damage) && action.damage.length
      ? { ...action, acknowledged_damage: action.damage.map((item) => String(item.kind)) }
      : action)),
  };
}

/** The server's marks copied onto the card's own actions (by trip), when save was refused for them. */
export function withServerDamage(proposal: AIProposal, server: unknown): AIProposal {
  const actions = server && typeof server === "object" && Array.isArray((server as AIProposal).actions) ? (server as AIProposal).actions : [];
  const byTrip = new Map(actions.filter((action) => action.trip_id && Array.isArray(action.damage) && action.damage.length).map((action) => [action.trip_id, action.damage]));
  if (!byTrip.size) return proposal;
  return {
    ...proposal,
    actions: proposal.actions.map((action) => {
      const verb = String(action.action || "").toLowerCase();
      const damage = action.trip_id && (verb === "patch" || verb === "upsert") ? byTrip.get(action.trip_id) : undefined;
      return damage ? { ...action, damage } : action;
    }),
  };
}

export function DamageNotice({ items, checked, onToggle, disabled }: { items: DamagedAction[]; checked: boolean; onToggle: (next: boolean) => void; disabled?: boolean }) {
  if (!items.length) return null;
  return (
    <section role="alert" className="mx-4 mt-3 rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-3 text-[13px] leading-5 text-danger sm:mx-6">
      <p className="flex items-start gap-2 font-semibold">
        <Icons.alert size={15} className="mt-0.5 shrink-0" />
        <span>Анхаар: энэ санал хадгалагдсан {items.length > 1 ? `${items.length} аяллыг` : "аяллыг"} эвдэж болзошгүй</span>
      </p>
      <ul className="mt-2 space-y-1.5 pl-6">
        {items.map((item) => (
          <li key={item.index}>
            <span className="font-semibold">«{item.name}»</span>: {item.lines.join(" ")}
          </li>
        ))}
      </ul>
      <label className="mt-2.5 flex cursor-pointer items-start gap-2 pl-6 font-medium text-ink">
        <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-danger" checked={checked} disabled={disabled} onChange={(event) => onToggle(event.target.checked)} />
        <span>Ойлголоо — энэ өөрчлөлтийг санаатайгаар хадгална. Буруу бол «Болих» дарна уу.</span>
      </label>
    </section>
  );
}
