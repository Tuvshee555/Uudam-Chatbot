import React from "react";
import { Button, Icons, Input, Textarea } from "@/components/ui";
import { websiteDetailFields } from "@/lib/websiteTripDetails";
import type { TravelTrip } from "@/lib/adminTypes";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export function WebsiteTripFields({ trip, draft, onChange }: { trip: TravelTrip | null; draft?: string; onChange: (value: string) => void }) {
  const source = record(trip?.extra.website_details);
  const values = draft ? record(JSON.parse(draft)) : source;
  const set = (key: string, value: unknown) => onChange(JSON.stringify({ ...values, [key]: value }));
  if (!Object.keys(source).length) return <p className="text-sm text-ink-muted">Вебсайт аялал холбогдоогүй байна.</p>;
  return <div className="space-y-5 min-w-0">
    <div className="grid gap-4 sm:grid-cols-2">
      {websiteDetailFields.filter((field) => field.type !== "media").map((field) => {
        const value = values[field.key];
        if (field.type === "boolean") return <label key={field.key} className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={value === true} onChange={(event) => set(field.key, event.target.checked)} />{field.label}</label>;
        if (field.type === "number") return <Input key={field.key} label={field.label} type="number" min={field.key === "minTravelers" || field.key === "maxTravelers" ? 1 : 0} step={1} value={typeof value === "number" ? String(value) : ""} onChange={(event) => set(field.key, event.target.value === "" ? null : Number(event.target.value))} />;
        return <div key={field.key} className={field.type === "text" && ["requirements", "cancellationPolicy"].includes(field.key) ? "sm:col-span-2" : ""}>
          <Textarea label={field.label} rows={field.type === "list" ? 3 : 2} value={Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : ""}
            onChange={(event) => set(field.key, field.type === "list" ? event.target.value.split("\n").filter((item) => item.trim()) : event.target.value || null)} />
        </div>;
      })}
    </div>
    {websiteDetailFields.filter((field) => field.type === "media").map((field) => {
      const items = Array.isArray(values[field.key]) ? (values[field.key] as unknown[]).map(record) : [];
      const update = (index: number, patch: Row) => set(field.key, items.map((item, i) => i === index ? { ...item, ...patch } : item));
      return <section key={field.key} className="border-t border-line pt-4"><h3 className="mb-3 text-sm font-semibold text-ink">{field.label}</h3>
        <div className="space-y-3">{items.map((item, i) => <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input label="URL" value={String(item.url || "")} onChange={(event) => update(i, { url: event.target.value })} />
          <Input label="Тайлбар" value={String(item.caption || "")} onChange={(event) => update(i, { caption: event.target.value })} />
          <button type="button" title="Мөр хасах" aria-label="Мөр хасах" className="self-end rounded-md p-2 text-ink-muted hover:bg-danger-soft hover:text-danger" onClick={() => set(field.key, items.filter((_, index) => index !== i))}><Icons.trash size={16} /></button>
        </div>)}</div>
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => set(field.key, [...items, { url: "", caption: "" }])}><Icons.plus size={14} />Нэмэх</Button>
      </section>;
    })}
  </div>;
}

function valueText(value: unknown): string {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) return value.map(valueText).join("\n");
  if (typeof value === "object") return Object.entries(record(value)).map(([key, item]) => `${key}: ${valueText(item)}`).join("\n");
  return String(value);
}
export function TripTextComparison({ trip }: { trip: TravelTrip | null }) {
  const website = record(trip?.extra.website_details);
  const conflicts = [...(Array.isArray(trip?.extra.shared_conflicts) ? trip.extra.shared_conflicts : []), ...(Array.isArray(website.contentConflicts) ? website.contentConflicts : [])];
  const rows = [
    { label: "Аяллын нэр", chatbot: trip?.route_name, website: website.title },
    { label: "Тайлбар", chatbot: trip?.notes, website: website.description },
    { label: "Товч тайлбар", chatbot: trip?.extra.website_summary, website: website.summary },
    { label: "Том хүний үндсэн үнэ", chatbot: trip?.adult_price, website: website.price },
    { label: "Хүүхдийн үндсэн үнэ", chatbot: trip?.child_price, website: website.childPrice },
    { label: "Нярайн үндсэн үнэ", chatbot: trip?.infant_price, website: website.infantPrice },
  ];
  return <div className="space-y-5">
    {rows.map((row) => <section key={row.label} className="border-t border-line pt-4"><h3 className="mb-2 text-sm font-semibold text-ink">{row.label}</h3><div className="grid gap-4 sm:grid-cols-2">{(["chatbot", "website"] as const).map((side) => <div key={side} className="min-w-0 text-sm"><p className="mb-2 text-xs font-medium text-ink-muted">{side === "chatbot" ? "Chatbot" : "Вебсайт"}</p><p className="whitespace-pre-wrap break-words text-ink">{valueText(row[side])}</p></div>)}</div></section>)}
    {conflicts.length > 0 && <section className="border-t border-line pt-4"><h3 className="text-sm font-semibold text-warning">Шалгах зөрүү: {conflicts.length}</h3><div className="mt-3 space-y-4">{conflicts.map((entry, i) => {
      const conflict = record(entry);
      return <div key={i} className="border-b border-line pb-3"><p className="mb-2 text-xs font-medium text-ink-muted">{String(conflict.field || "")}</p><div className="grid gap-4 sm:grid-cols-2"><p className="min-w-0 whitespace-pre-wrap break-words text-sm text-ink">Chatbot: {valueText(conflict.chatbot)}</p><p className="min-w-0 whitespace-pre-wrap break-words text-sm text-ink">Вебсайт: {valueText(conflict.website)}</p></div></div>;
    })}</div></section>}
  </div>;
}
