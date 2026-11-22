import { useEffect, useMemo, useState } from "react";
import { cx, useToast } from "@/components/ui";
import type { TravelTrip } from "@/lib/adminTypes";
import { salePercent } from "@/lib/departureDeals";

type SeatState = "open" | "low" | "full";
type Row = { date: string; state: SeatState | "paused" };
/** One date's regular fares and its sale/«Онцлох», as the website's departure row holds them. */
type Deal = { regularAdult: number | null; regularChild: number | null; salePrice: number | null; saleChildPrice: number | null; featured: boolean };

const OPTIONS: Array<{ value: SeatState; label: string; on: string }> = [
  { value: "open", label: "Нээлттэй", on: "bg-brand-soft text-brand" },
  { value: "low", label: "Цөөн суудал", on: "bg-warning-soft text-warning" },
  { value: "full", label: "Дүүрсэн", on: "bg-danger-soft text-danger" },
];
const WEEKDAYS = ["Ням", "Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба"];
const EMPTY_DEAL: Deal = { regularAdult: null, regularChild: null, salePrice: null, saleChildPrice: null, featured: false };

function label(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return `${m}-р сарын ${d} · ${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
}

const money = (n: number) => `${n.toLocaleString("en-US")}₮`;
/** "2 990 000", "2,990,000₮" → 2990000; "" → null; anything else → NaN. */
function parseFare(text: string): number | null {
  const cleaned = text.replace(/[\s,.₮]/g, "");
  if (!cleaned) return null;
  return /^\d+$/.test(cleaned) ? Number(cleaned) : NaN;
}
const fareText = (n: number | null) => (n === null ? "" : n.toLocaleString("en-US"));

/** The trip's upcoming dates and what each one currently is, from the live website rows. */
function rowsOf(trip: TravelTrip): Row[] {
  const today = new Date().toISOString().slice(0, 10);
  const raw = Array.isArray(trip.extra?.website_departure_availability) ? trip.extra.website_departure_availability : [];
  return raw.flatMap((entry): Row[] => {
    const row = entry as { date?: unknown; status?: unknown; seatsLeft?: unknown };
    if (typeof row.date !== "string" || row.date < today) return [];
    const status = String(row.status || "").toUpperCase();
    if (status === "CANCELLED" || status === "DEPARTED") return [];
    const state: Row["state"] = status === "ALMOST_FULL" ? "low"
      : status === "SOLD_OUT" || row.seatsLeft === 0 ? "full"
        : status === "PAUSED" ? "paused" : "open";
    return [{ date: row.date, state }];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

/** "3,290,000₮ → 2,990,000₮ (−9%)" */
function SaleLine({ regular, sale }: { regular: number | null; sale: number | null }) {
  if (sale === null) return null;
  const percent = salePercent(regular, sale);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
      {regular !== null && <span className="text-ink-muted line-through">{money(regular)}</span>}
      <span className="font-semibold text-danger">{money(sale)}</span>
      {percent !== null && <span className="rounded bg-danger-soft px-1.5 py-0.5 font-semibold text-danger">−{percent}%</span>}
    </span>
  );
}

/**
 * Each date of the trip, with everything that is set on that one date: its seats («Цөөн суудал» /
 * «Дүүрсэн»), a sale fare («Хямдрал», old → new with the percent) and «Онцлох». The website and the
 * bot show each one beside that date only. Seats and «Онцлох» save on click; a sale on «Хадгалах».
 */
export function DateSeatsEditor({
  trip,
  apiFetch,
}: {
  trip: TravelTrip;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const toast = useToast();
  const initial = useMemo(() => rowsOf(trip), [trip]);
  const [states, setStates] = useState<Record<string, Row["state"]>>({});
  const [deals, setDeals] = useState<Record<string, Deal>>({});
  const [drafts, setDrafts] = useState<Record<string, { adult: string; child: string }>>({});
  const [openSale, setOpenSale] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = initial.map((row) => ({ ...row, state: states[row.date] ?? row.state }));
  const lowCount = rows.filter((row) => row.state === "low").length;
  const saleCount = rows.filter((row) => deals[row.date]?.salePrice != null || deals[row.date]?.saleChildPrice != null).length;
  const featuredCount = rows.filter((row) => deals[row.date]?.featured).length;

  useEffect(() => {
    let live = true;
    apiFetch(`/api/admin/departure-deal?tripId=${encodeURIComponent(trip.id)}`)
      .then((response) => (response.ok ? response.json() : { dates: [] }))
      .then((body: { dates?: Array<Deal & { date: string }> }) => {
        if (!live) return;
        setDeals(Object.fromEntries((body.dates || []).map(({ date, ...deal }) => [date, { ...EMPTY_DEAL, ...deal }])));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [apiFetch, trip.id]);

  async function choose(date: string, state: SeatState) {
    const before = rows.find((row) => row.date === date)?.state;
    if (busy || before === state) return;
    setBusy(date);
    setStates((current) => ({ ...current, [date]: state }));
    try {
      const response = await apiFetch("/api/admin/departure-seats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tripId: trip.id, date, state }),
      });
      if (!response.ok) throw new Error("save failed");
      toast.success(`${label(date)} — ${OPTIONS.find((option) => option.value === state)?.label}`);
    } catch {
      setStates((current) => ({ ...current, [date]: before ?? "open" }));
      toast.error("Хадгалахад алдаа гарлаа.");
    } finally {
      setBusy(null);
    }
  }

  async function saveDeal(date: string, patch: { salePrice?: number | null; saleChildPrice?: number | null; featured?: boolean }, done: string) {
    if (busy) return false;
    setBusy(date);
    try {
      const response = await apiFetch("/api/admin/departure-deal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tripId: trip.id, date, ...patch }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(typeof body.message === "string" ? body.message : "Хадгалахад алдаа гарлаа.");
        return false;
      }
      setDeals((current) => ({ ...current, [date]: { regularAdult: body.regularAdult ?? null, regularChild: body.regularChild ?? null, salePrice: body.salePrice ?? null, saleChildPrice: body.saleChildPrice ?? null, featured: body.featured === true } }));
      toast.success(`${label(date)} — ${done}`);
      return true;
    } catch {
      toast.error("Хадгалахад алдаа гарлаа.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function startSale(date: string) {
    const deal = deals[date] ?? EMPTY_DEAL;
    setDrafts((current) => ({ ...current, [date]: { adult: fareText(deal.salePrice), child: fareText(deal.saleChildPrice) } }));
    setOpenSale(openSale === date ? null : date);
  }

  async function submitSale(date: string) {
    const draft = drafts[date] ?? { adult: "", child: "" };
    const adult = parseFare(draft.adult);
    const child = parseFare(draft.child);
    if (Number.isNaN(adult) || Number.isNaN(child)) { toast.error("Үнийг тоогоор бичнэ үү."); return; }
    if (adult === null && child === null) { toast.error("Хямдралтай үнээ бичнэ үү."); return; }
    const deal = deals[date] ?? EMPTY_DEAL;
    const percent = salePercent(deal.regularAdult, adult) ?? salePercent(deal.regularChild, child);
    if (await saveDeal(date, { salePrice: adult, saleChildPrice: child }, `хямдрал${percent ? ` −${percent}%` : ""} хадгалагдлаа`)) setOpenSale(null);
  }

  return (
    <div>
      {(lowCount > 0 || saleCount > 0 || featuredCount > 0) && (
        <p className="mb-2 flex flex-wrap gap-x-3 text-xs font-medium">
          {lowCount > 0 && <span className="text-warning">{lowCount} өдөр «Цөөн суудал» гэж харагдаж байна.</span>}
          {saleCount > 0 && <span className="text-danger">{saleCount} өдөр хямдралтай</span>}
          {featuredCount > 0 && <span className="text-brand">{featuredCount} өдөр «Онцлох»</span>}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-ink-muted">
          Вэбсайтад нийтлэгдсэн гарах өдөр алга. Огноогоо хадгалж, аяллаа идэвхтэй болгосны дараа энд сонгоно.
        </p>
      ) : (
        <ul className="max-h-[28rem] divide-y divide-line overflow-y-auto rounded-lg border border-line px-3">
          {rows.map((row) => {
            const deal = deals[row.date] ?? EMPTY_DEAL;
            const onSale = deal.salePrice !== null || deal.saleChildPrice !== null;
            const draft = drafts[row.date] ?? { adult: "", child: "" };
            const draftAdult = parseFare(draft.adult);
            const draftChild = parseFare(draft.child);
            const tooHigh = (sale: number | null, regular: number | null) => typeof sale === "number" && !Number.isNaN(sale) && regular !== null && sale >= regular;
            return (
              <li key={row.date} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 text-sm">
                    <span className="font-medium text-ink">{label(row.date)}</span>
                    {row.state === "paused" && <span className="ml-2 text-xs text-ink-muted">Түр хаасан</span>}
                    {deal.featured && <span className="ml-2 rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand">Онцлох</span>}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span role="radiogroup" aria-label={`${label(row.date)} суудлын төлөв`} className="inline-flex overflow-hidden rounded-lg border border-line-strong">
                      {OPTIONS.map((option) => {
                        const active = row.state === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            disabled={busy === row.date}
                            onClick={() => void choose(row.date, option.value)}
                            className={cx(
                              "border-r border-line-strong px-3 py-1.5 text-xs font-medium transition-colors last:border-r-0 disabled:opacity-60",
                              active ? option.on : "bg-surface text-ink-muted hover:bg-surface-sunken",
                            )}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </span>
                    <button
                      type="button"
                      aria-pressed={onSale}
                      disabled={busy === row.date}
                      onClick={() => startSale(row.date)}
                      className={cx("rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                        onSale ? "border-danger bg-danger-soft text-danger" : "border-line-strong bg-surface text-ink-muted hover:bg-surface-sunken")}
                    >
                      Хямдрал
                    </button>
                    <button
                      type="button"
                      aria-pressed={deal.featured}
                      disabled={busy === row.date}
                      onClick={() => void saveDeal(row.date, { featured: !deal.featured }, deal.featured ? "«Онцлох»-оос хаслаа" : "«Онцлох» боллоо")}
                      className={cx("rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                        deal.featured ? "border-brand bg-brand-soft text-brand" : "border-line-strong bg-surface text-ink-muted hover:bg-surface-sunken")}
                    >
                      ★ Онцлох
                    </button>
                  </span>
                </div>
                {onSale && openSale !== row.date && (
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {deal.salePrice !== null && <span className="text-xs text-ink-muted">Том хүн: <SaleLine regular={deal.regularAdult} sale={deal.salePrice} /></span>}
                    {deal.saleChildPrice !== null && <span className="text-xs text-ink-muted">Хүүхэд: <SaleLine regular={deal.regularChild} sale={deal.saleChildPrice} /></span>}
                  </div>
                )}
                {openSale === row.date && (
                  <div className="mt-2 rounded-lg border border-line bg-surface-sunken p-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      {([
                        ["adult", "Том хүний хямдралтай үнэ", deal.regularAdult, draftAdult],
                        ["child", "Хүүхдийн хямдралтай үнэ (заавал биш)", deal.regularChild, draftChild],
                      ] as const).map(([key, title, regular, value]) => (
                        <label key={key} className="block text-xs text-ink-muted">
                          <span className="mb-1 block font-medium text-ink">{title}</span>
                          <input
                            inputMode="numeric"
                            value={draft[key]}
                            placeholder={regular !== null ? `Энгийн үнэ ${money(regular)}` : "ж: 2,990,000"}
                            onChange={(event) => setDrafts((current) => ({ ...current, [row.date]: { ...draft, [key]: event.target.value } }))}
                            onKeyDown={(event) => { if (event.key === "Enter") void submitSale(row.date); }}
                            className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink tabular-nums outline-none focus:border-brand"
                          />
                          <span className="mt-1 block min-h-[1.25rem]">
                            {tooHigh(value, regular)
                              ? <span className="text-danger">Энгийн үнээс ({money(regular!)}) бага байх ёстой.</span>
                              : typeof value === "number" && !Number.isNaN(value) ? <SaleLine regular={regular} sale={value} /> : null}
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap justify-end gap-2">
                      {onSale && (
                        <button type="button" disabled={busy === row.date}
                          onClick={async () => { if (await saveDeal(row.date, { salePrice: null, saleChildPrice: null }, "хямдрал арилгалаа")) setOpenSale(null); }}
                          className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-sunken disabled:opacity-60">
                          Хямдрал арилгах
                        </button>
                      )}
                      <button type="button" onClick={() => setOpenSale(null)}
                        className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-sunken">
                        Болих
                      </button>
                      <button type="button" disabled={busy === row.date || tooHigh(draftAdult, deal.regularAdult) || tooHigh(draftChild, deal.regularChild)}
                        onClick={() => void submitSale(row.date)}
                        className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60">
                        Хадгалах
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
