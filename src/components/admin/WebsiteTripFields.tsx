import React from "react";
import { Button, Icons, Input, Select, Textarea } from "@/components/ui";
import { websiteDetailFields } from "@/lib/websiteTripDetails";
import type { TravelTrip } from "@/lib/adminTypes";
import { uploadAdminMedia } from "@/lib/adminMediaUpload";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const linkHost = (value: unknown) => {
  try { const url = new URL(String(value)); return ["https:", "http:"].includes(url.protocol) ? url.hostname : ""; }
  catch { return ""; }
};
const mediaKeys = new Set<string>(["hotelMedia", "travelerMedia", "video", "videos", "brochurePdfUrl"]);
const DIFFICULTY: Record<string, string> = { EASY: "Хөнгөн", MODERATE: "Дунд", CHALLENGING: "Хүнд" };
const PLACEHOLDER: Record<string, string> = { country: "ж: Хятад", city: "ж: Бээжин", meetingPoint: "ж: Төмөр замын буудал", mapUrl: "https://…", season: "ж: Намар", video: "https://…", brochurePdfUrl: "https://…" };
const detailSections = [
  { title: "Байршил, зохион байгуулалт", keys: ["country", "city", "region", "destinations", "transport", "languages", "meetingPoint", "mapUrl", "season", "difficulty", "minTravelers", "maxTravelers"], open: true },
  { title: "Нэмэлт үнэ, хямдрал", keys: ["oldPrice", "discount", "singleSupplement", "extraFees", "roomPrices", "childPriceNotes"], open: false },
  { title: "Танилцуулга, нөхцөл", keys: ["isFeatured", "highlights", "requirements", "cancellationPolicy"], open: false },
];
export function WebsiteTripFields({ trip, draft, onChange, scope = "general", apiFetch, onBusyChange }: { trip: TravelTrip | null; draft?: string; onChange: (value: string) => void; scope?: "general" | "media"; apiFetch?: (url: string, init?: RequestInit) => Promise<Response>; onBusyChange?: (busy: boolean) => void }) {
  const source = record(trip?.extra.website_details);
  const values = draft ? record(JSON.parse(draft)) : source;
  const valuesRef = React.useRef(values);
  valuesRef.current = values;
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState("");
  const set = (key: string, value: unknown) => {
    const next = { ...valuesRef.current, [key]: value };
    valuesRef.current = next;
    onChange(JSON.stringify(next));
  };
  async function upload(key: string, file: File | undefined) {
    if (!file || !apiFetch) return;
    setUploadError("");
    setUploading(true);
    onBusyChange?.(true);
    try {
      const url = await uploadAdminMedia(file, apiFetch);
      const current = Array.isArray(valuesRef.current[key]) ? valuesRef.current[key] as unknown[] : [];
      set(key, [...current, { url, caption: "" }]);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Байршуулж чадсангүй.");
    } finally {
      setUploading(false);
      onBusyChange?.(false);
    }
  }
  if (!Object.keys(source).length) return <p className="text-sm text-ink-muted">Вебсайт аялал холбогдоогүй байна.</p>;
  return <div className="min-w-0 space-y-4">
    {(scope === "general" ? detailSections : [{ title: "Бичлэг, брошур", keys: ["video", "videos", "brochurePdfUrl"], open: true }]).map((section) => <details key={section.title} open={section.open} className="group rounded-xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3.5 text-[15px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
        {section.title}
        <Icons.chevronRight size={16} className="shrink-0 rotate-90 text-ink-subtle transition-transform group-open:-rotate-90" />
      </summary>
      <div className="grid gap-4 border-t border-line px-4 pb-4 pt-4 sm:grid-cols-2">
      {websiteDetailFields.filter((field) => section.keys.includes(field.key) && (scope === "media" || !mediaKeys.has(field.key))).map((field) => {
        const value = values[field.key];
        if (field.type === "boolean") return <label key={field.key} className="flex items-center gap-2.5 text-sm font-medium text-ink sm:col-span-2"><input type="checkbox" className="h-4 w-4 accent-brand" checked={value === true} onChange={(event) => set(field.key, event.target.checked)} />{field.label}</label>;
        if (field.key === "difficulty") return <Select key={field.key} label={field.label} value={typeof value === "string" ? value : ""} onChange={(event) => set(field.key, event.target.value || null)}>
          <option value="">Сонгоогүй</option>
          {Object.entries(DIFFICULTY).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </Select>;
        if (field.type === "number") return <Input key={field.key} label={field.label} inputMode="numeric" value={typeof value === "number" ? String(value) : ""} onChange={(event) => { const digits = event.target.value.replace(/[^\d]/g, ""); set(field.key, digits === "" ? null : Number(digits)); }} />;
        if (field.type === "text" && !["requirements", "cancellationPolicy"].includes(field.key)) return <Input key={field.key} label={field.label} placeholder={PLACEHOLDER[field.key]} value={typeof value === "string" ? value : ""} onChange={(event) => set(field.key, event.target.value || null)} />;
        return <div key={field.key} className={field.type === "text" || field.type === "list" ? "sm:col-span-2" : ""}>
          <Textarea label={field.label} hint={field.type === "list" ? "Нэг мөрөнд нэг зүйл." : undefined} rows={3} className="[field-sizing:content] min-h-20" value={Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : ""}
            onChange={(event) => set(field.key, field.type === "list" ? event.target.value.split("\n").filter((item) => item.trim()) : event.target.value || null)} />
        </div>;
      })}
      </div>
    </details>)}
    {scope === "media" && websiteDetailFields.filter((field) => field.type === "media").map((field) => {
      const items = Array.isArray(values[field.key]) ? (values[field.key] as unknown[]).map(record) : [];
      const update = (index: number, patch: Row) => set(field.key, items.map((item, i) => i === index ? { ...item, ...patch } : item));
      return <section key={field.key} className="rounded-xl border border-line bg-surface p-4"><h3 className="mb-3 text-[15px] font-semibold text-ink">{field.label}</h3>
        <div className="space-y-3">{items.map((item, i) => <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input label="Холбоос" value={String(item.url || "")} placeholder="https://" onChange={(event) => update(i, { url: event.target.value })} />
          <Input label="Тайлбар" value={String(item.caption || "")} onChange={(event) => update(i, { caption: event.target.value })} />
          <button type="button" title="Мөр хасах" aria-label="Мөр хасах" className="self-end rounded-md p-2 text-ink-muted hover:bg-danger-soft hover:text-danger" onClick={() => set(field.key, items.filter((_, index) => index !== i))}><Icons.trash size={16} /></button>
        </div>)}</div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => set(field.key, [...items, { url: "", caption: "" }])}><Icons.plus size={14} />Холбоос нэмэх</Button>
          {apiFetch && [["image", "Зураг"], ["video", "Бичлэг"]].map(([kind, label]) => <label key={kind} className={`inline-flex items-center gap-2 rounded-md border border-line-strong px-3 py-2 text-sm text-ink ${uploading ? "opacity-50" : "cursor-pointer"}`}>
            <Icons.upload size={14} />{label}
            <input aria-label={`${field.label}: ${label} байршуулах`} type="file" accept={`${kind}/*`} disabled={uploading} className="sr-only" onChange={(event) => { void upload(field.key, event.target.files?.[0]); event.target.value = ""; }} />
          </label>)}
        </div>
        {items.map((item, i) => typeof item.url === "string" && linkHost(item.url) ? <a key={`preview-${i}`} href={item.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex max-w-full items-center gap-2 text-xs text-brand">
          {/[.](jpg|jpeg|png|webp|gif)([?#]|$)|\/image\/upload\//i.test(item.url) ?
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={item.url} alt={String(item.caption || field.label)} className="h-16 w-24 rounded-md object-cover" /> : <Icons.image size={16} />}
          <span className="truncate">{String(item.caption || linkHost(item.url))}</span>
        </a> : null)}
      </section>;
    })}
    {uploading && <p role="status" className="text-sm text-ink-muted">Файл байршуулж байна...</p>}
    {uploadError && <p role="alert" className="text-sm text-danger">{uploadError}</p>}
  </div>;
}

const SEAT_STATUS: Record<string, string> = { OPEN: "Нээлттэй", ALMOST_FULL: "Цөөн суудал", SOLD_OUT: "Дүүрсэн", CANCELLED: "Цуцалсан", DEPARTED: "Явсан", PAUSED: "Түр хаасан" };
const FIELD_LABEL: Record<string, string> = {
  website_departure_availability: "Гарах өдрүүд (суудал)", departures: "Гарах өдрүүд",
  title: "Аяллын нэр", description: "Тайлбар", summary: "Товч тайлбар", price: "Том хүний үнэ", childPrice: "Хүүхдийн үнэ", infantPrice: "Нярайн үнэ",
};
const DEPARTURE_FARE_LABEL: Record<string, string> = { price: "том хүний үнэ", childPrice: "хүүхдийн үнэ", infantPrice: "нярайн үнэ" };
const fieldLabel = (key: string) => {
  // A fare typed on the website for one departure of a package-priced trip (websiteTripBridge.ts).
  const departure = /^departure\.(\d{4}-\d{2}-\d{2})\.(price|childPrice|infantPrice)$/.exec(key);
  if (departure) return `${departure[1]} гарах өдрийн ${DEPARTURE_FARE_LABEL[departure[2]]}`;
  const bare = key.replace(/^(?:website|extra)\./, ""); return FIELD_LABEL[bare] || bare;
};
function valueText(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (Array.isArray(value)) {
    if (value.length && value.every((item) => typeof record(item).date === "string")) {
      return value.map((item) => { const row = record(item); const status = String(row.status || ""); return `${row.date} · ${SEAT_STATUS[status] || status || "—"}${typeof row.seatsLeft === "number" ? ` · ${row.seatsLeft} суудал` : ""}`; }).join("\n");
    }
    return value.map(valueText).join("\n");
  }
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
  const same = (a: unknown, b: unknown) => valueText(a).replace(/\s+/g, " ").trim() === valueText(b).replace(/\s+/g, " ").trim();
  return <div className="space-y-3">
    <div className="hidden grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)] gap-4 px-3 text-xs font-medium text-ink-muted sm:grid"><span /><span>Чатбот</span><span>Вэбсайт</span></div>
    {rows.map((row) => { const match = same(row.chatbot, row.website); return <section key={row.label} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)] sm:gap-4">
      <h3 className="flex items-start gap-1.5 text-sm font-semibold text-ink">{match ? <Icons.check size={14} className="mt-0.5 shrink-0 text-success" /> : <Icons.alert size={14} className="mt-0.5 shrink-0 text-warning" />}{row.label}</h3>
      {(["chatbot", "website"] as const).map((side) => <div key={side} className="min-w-0 text-sm"><p className="mb-1 text-xs font-medium text-ink-muted sm:hidden">{side === "chatbot" ? "Чатбот" : "Вэбсайт"}</p><p className="line-clamp-6 whitespace-pre-wrap break-words text-ink">{valueText(row[side])}</p></div>)}
    </section>; })}
    {conflicts.length > 0 && <section className="pt-2"><h3 className="text-sm font-semibold text-warning">Зөрүүтэй: {conflicts.length}</h3><div className="mt-2 space-y-2">{conflicts.map((entry, i) => {
      const conflict = record(entry);
      return <div key={i} className="grid gap-2 rounded-lg border border-warning/30 bg-warning-soft/40 p-3 sm:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)] sm:gap-4"><p className="text-sm font-semibold text-ink">{fieldLabel(String(conflict.field || ""))}</p><p className="min-w-0 whitespace-pre-wrap break-words text-sm text-ink"><span className="text-xs text-ink-muted sm:hidden">Чатбот: </span>{valueText(conflict.chatbot)}</p><p className="min-w-0 whitespace-pre-wrap break-words text-sm text-ink"><span className="text-xs text-ink-muted sm:hidden">Вэбсайт: </span>{valueText(conflict.website)}</p></div>;
    })}</div></section>}
  </div>;
}
