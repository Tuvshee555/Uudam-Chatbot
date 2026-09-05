import { useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, IconButton, Icons, Modal, Spinner, cx, useToast } from "@/components/ui";
import { TabHeader } from "./AdminShared";
import type { TravelTrip } from "@/lib/adminTypes";
import { STATUS_LABELS } from "@/lib/adminProposalUtils";
import { STATUS_TONE, formatTime } from "@/lib/adminUtils";
import { getPosterBrochureHref } from "@/lib/poster/pdfUrl";

export function TripsTab({
  trips,
  search,
  setSearch,
  statusFilter,
  setStatusFilter,
  loading,
  onRefresh,
  onCreate,
  onEdit,
  onDelete,
  onDeleteAll,
  onToggleVisible,
  onFetchAllTrips,
  businessName,
}: {
  trips: TravelTrip[];
  search: string;
  setSearch: (value: string) => void;
  statusFilter: string;
  setStatusFilter: (value: string) => void;
  loading: boolean;
  onRefresh: () => void;
  onCreate: () => void;
  onEdit: (trip: TravelTrip) => void;
  onDelete: (trip: TravelTrip) => void;
  onDeleteAll: () => void;
  onToggleVisible: (trip: TravelTrip) => void;
  /** Loads every trip, ignoring the on-screen search/status filter. */
  onFetchAllTrips: () => Promise<TravelTrip[]>;
  /** Agency name for the brochure cover, from bot settings. */
  businessName: string;
}) {
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [brochureFilter, setBrochureFilter] = useState<"all" | "with" | "without">("all");
  const [pdfProgress, setPdfProgress] = useState("");
  const toast = useToast();

  const tripsWithoutPdf = useMemo(
    () => trips.filter((t) => !tripHasPdf(t)),
    [trips],
  );
  const tripsWithPdf = useMemo(
    () => trips.filter((t) => tripHasPdf(t)),
    [trips],
  );
  const visibleTrips =
    brochureFilter === "without" ? tripsWithoutPdf :
    brochureFilter === "with" ? tripsWithPdf :
    trips;

  /**
   * The brochure staff send a customer who asks to see the trips. Always pulls
   * a fresh unfiltered list — the search box must not decide what a customer
   * receives — and the builder then drops anything not active or hidden.
   */
  async function handleExportPdf() {
    if (pdfProgress) return;
    setPdfProgress("Аяллын мэдээлэл цуглуулж байна…");
    try {
      const allTrips = await onFetchAllTrips();
      const { downloadTripCatalogPdf, customerVisibleTrips } = await import("@/lib/tripCatalogPdf");
      if (customerVisibleTrips(allTrips).length === 0) {
        toast.error("Үйлчлүүлэгчид харагдах идэвхтэй аялал алга байна.");
        return;
      }
      const result = await downloadTripCatalogPdf(allTrips, {
        businessName: businessName || undefined,
        onProgress: (message) => setPdfProgress(message),
      });
      const notes = [
        result.hiddenCount > 0 ? `${result.hiddenCount} нуугдсан/идэвхгүй аялал ороогүй` : "",
        result.textOnlyCount > 0 ? `${result.textOnlyCount} аялал зураггүй` : "",
        result.failedPhotoCount > 0 ? `${result.failedPhotoCount} зураг татагдсангүй` : "",
      ].filter(Boolean);
      toast.success(
        `${result.tripCount} аяллын танилцуулга татагдлаа${notes.length ? ` — ${notes.join(", ")}` : ""}.`,
      );
    } catch (error) {
      toast.error(`PDF үүсгэж чадсангүй: ${String((error as { message?: string })?.message || error)}`);
    } finally {
      setPdfProgress("");
    }
  }

  function handleExportJson() {
    const data = trips.map((t) => ({
      id: t.id,
      operator_name: t.operator_name,
      route_name: t.route_name,
      category: t.category,
      duration_text: t.duration_text,
      adult_price: t.adult_price,
      child_price: t.child_price,
      currency: t.currency,
      departure_dates: t.departure_dates,
      seats_total: t.seats_total,
      seats_left: t.seats_left,
      has_food: t.has_food,
      status: t.status,
      hotel: t.hotel,
      notes: t.notes,
      source_description: t.source_description,
      updated_at: t.updated_at,
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `uudam-trips-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${data.length} аялал татаж авлаа`);
  }

  function handleExportCsv() {
    const headers = [
      "id","operator_name","route_name","category","duration_text",
      "adult_price","child_price","currency","departure_dates",
      "seats_total","seats_left","has_food","status","hotel","notes","updated_at",
    ];
    const rows = trips.map((t) => [
      t.id,
      t.operator_name,
      t.route_name,
      t.category,
      t.duration_text,
      t.adult_price ?? "",
      t.child_price ?? "",
      t.currency,
      t.departure_dates.join("; "),
      t.seats_total ?? "",
      t.seats_left ?? "",
      t.has_food == null ? "" : t.has_food ? "true" : "false",
      t.status,
      t.hotel,
      t.notes,
      t.updated_at,
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`));
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `uudam-trips-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${trips.length} аялал CSV татаж авлаа`);
  }

  return (
    <div className="space-y-3">
      {/* Delete-all confirmation modal */}
      <Modal
        open={confirmDeleteAll}
        onClose={() => setConfirmDeleteAll(false)}
        title="Бүх аялал устгах уу?"
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            Одоо байгаа <span className="font-semibold text-ink">{trips.length} аялал</span> бүгдийг устгах гэж байна. Энэ үйлдлийг буцаах боломжгүй.
          </p>
          <p className="text-sm text-ink-muted">
            Устгахын өмнө доорх товчоор татаж авахыг зөвлөж байна.
          </p>
          {/* Backups only. The PDF brochure is deliberately NOT offered here —
              it drops hidden/inactive trips and every internal field, so it
              would be a lossy backup of what is about to be deleted. */}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={handleExportJson}>
              <Icons.download size={15} />
              JSON татах
            </Button>
            <Button variant="secondary" size="sm" onClick={handleExportCsv}>
              <Icons.download size={15} />
              CSV татах
            </Button>
          </div>
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button variant="secondary" onClick={() => setConfirmDeleteAll(false)}>
              Болих
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmDeleteAll(false);
                onDeleteAll();
              }}
            >
              <Icons.trash size={15} />
              Бүгдийг устгах
            </Button>
          </div>
        </div>
      </Modal>

      <TabHeader
        icon={<Icons.trips size={20} />}
        title="Аяллууд"
        description="Ботын мэддэг бүх аялал — хайх, засах, нуух, шинээр нэмэх."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => void handleExportPdf()}
              loading={!!pdfProgress}
              disabled={!!pdfProgress}
              title="Үйлчлүүлэгчид илгээх PDF танилцуулга — идэвхтэй аяллууд зурагтайгаа"
            >
              {!pdfProgress && <Icons.download size={16} />}
              {pdfProgress || "Танилцуулга татах (PDF)"}
            </Button>
            <Button onClick={onCreate}>
              <Icons.plus size={16} />
              Шинэ аялал
            </Button>
          </div>
        }
      />

      <Card className="p-3.5">
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Аяллын нэр хайх…"
              className="h-10 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink transition-colors placeholder:text-ink-subtle focus:border-brand"
            />
            <IconButton label="Шинэчлэх" onClick={onRefresh}>
              {loading ? <Spinner /> : <Icons.refresh size={17} />}
            </IconButton>
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-10 min-w-[10rem] flex-1 rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink transition-colors focus:border-brand"
            >
              <option value="">Бүх төлөв</option>
              <option value="active">Идэвхтэй</option>
              <option value="cancelled">Цуцлагдсан</option>
              <option value="sold_out">Суудал дууссан</option>
              <option value="draft">Ноорог</option>
              <option value="archived">Архив</option>
            </select>
            <div className="flex shrink-0 items-center rounded-md border border-line-strong bg-surface-sunken p-0.5">
              {(
                [
                  { key: "all", label: "Бүгд", count: trips.length },
                  { key: "with", label: "PDF-тэй", count: tripsWithPdf.length },
                  { key: "without", label: "PDFгүй", count: tripsWithoutPdf.length },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setBrochureFilter(opt.key)}
                  aria-pressed={brochureFilter === opt.key}
                  className={cx(
                    "flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-xs font-medium transition-colors",
                    brochureFilter === opt.key
                      ? "bg-surface text-ink shadow-xs"
                      : "text-ink-muted hover:text-ink",
                  )}
                >
                  {opt.label}
                  <span className="tabular-nums text-ink-subtle">{opt.count}</span>
                </button>
              ))}
            </div>
          </div>
          {/* JSON/CSV export the filtered list on screen. The full-catalogue PDF
              lives in the header instead, so the two are not mistaken for
              variants of the same export. */}
          {trips.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
              <button
                type="button"
                onClick={handleExportJson}
                className="flex items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted hover:border-brand hover:text-brand"
              >
                <Icons.download size={13} />
                JSON
              </button>
              <button
                type="button"
                onClick={handleExportCsv}
                className="flex items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted hover:border-brand hover:text-brand"
              >
                <Icons.download size={13} />
                CSV
              </button>
              <button
                type="button"
                onClick={() => setConfirmDeleteAll(true)}
                className="ml-auto flex items-center gap-1.5 rounded-md border border-danger/30 bg-surface px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/5"
              >
                <Icons.trash size={13} />
                Бүгдийг устгах
              </button>
            </div>
          )}
        </div>
      </Card>

      {tripsWithoutPdf.length > 0 && brochureFilter === "all" && (
        <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
          <Icons.alert size={16} className="shrink-0" />
          <span>
            {tripsWithoutPdf.length} аялалд автоматаар илгээх PDF алга байна.{" "}
            <button
              type="button"
              onClick={() => setBrochureFilter("without")}
              className="font-semibold underline hover:no-underline"
            >
              Харах
            </button>
          </span>
        </div>
      )}

      {visibleTrips.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            icon={<Icons.trips size={26} />}
            title="Аялал олдсонгүй"
            description="Шинэ аялал нэмэх, эсвэл AI Туслахаар прайс жагсаалт оруулна уу."
          />
        </Card>
      ) : (
        <TripGroups
          trips={visibleTrips}
          onEdit={onEdit}
          onDelete={onDelete}
          onToggleVisible={onToggleVisible}
        />
      )}
    </div>
  );
}

function tripHasPdf(trip: TravelTrip): boolean {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  return (
    (typeof extra.poster_trip_id === "string" && extra.poster_trip_id.trim().length > 0) ||
    (typeof extra.brochure_pdf_url === "string" && extra.brochure_pdf_url.startsWith("https://")) ||
    (typeof extra.source_file_attachment_id === "string" && extra.source_file_attachment_id.trim().length > 0)
  );
}

function isPosterSyncedTrip(trip: TravelTrip): boolean {
  return typeof (trip.extra as Record<string, unknown>)?.poster_trip_id === "string";
}

function tripConnectionDetails(trip: TravelTrip): { posterId: string; sourceFile: string; pdfUrl: string } {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  return {
    posterId: typeof extra.poster_trip_id === "string" ? extra.poster_trip_id : "",
    sourceFile: typeof extra.source_file_name === "string" ? extra.source_file_name : "",
    pdfUrl: getPosterBrochureHref(extra),
  };
}

function formatTripMoney(value: number | null | undefined, currency = "MNT"): string | null {
  if (typeof value !== "number") return null;
  const suffix = currency === "MNT" || !currency ? "₮" : ` ${currency}`;
  return `${value.toLocaleString("mn-MN")}${suffix}`;
}

type CalendarChip = { month: string; day: string };

function calendarDaySortValue(day: string): number {
  return Number(day.split("-")[0]) || 0;
}

function parseCalendarChips(value: string): CalendarChip[] {
  const text = value
    .replace(/\r?\n+/g, ", ")
    .replace(/(\d{1,2})\s*(?:-?р\s*)?сарын\s*(\d)/gi, "$1 сарын $2");
  const chips: CalendarChip[] = [];
  const monthPattern = /(\d{1,2})\s*(?:-?р\s*)?сарын/gi;
  const monthMatches = Array.from(text.matchAll(monthPattern));
  for (let i = 0; i < monthMatches.length; i += 1) {
    const match = monthMatches[i];
    const month = `${Number(match[1])} сар`;
    const start = (match.index || 0) + match[0].length;
    const end = monthMatches[i + 1]?.index ?? text.length;
    const segment = text.slice(start, end);
    for (const dayMatch of segment.matchAll(/(?<!\d)(\d{1,2})(?:\s*-\s*(\d{1,2}))?(?!\d)/g)) {
      const day = dayMatch[2] ? `${Number(dayMatch[1])}-${Number(dayMatch[2])}` : String(Number(dayMatch[1]));
      chips.push({ month, day });
    }
  }
  const slash = text.match(/(?<!\d)(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/);
  if (chips.length === 0 && slash) {
    chips.push({ month: `${Number(slash[1])} сар`, day: String(Number(slash[2])) });
  }
  return chips;
}

function DepartureCalendar({ dates }: { dates: string[] }) {
  const groups = new Map<string, string[]>();
  const rules: string[] = [];
  for (const raw of dates) {
    const chips = parseCalendarChips(raw);
    if (chips.length === 0) {
      if (raw.trim()) rules.push(raw.trim());
      continue;
    }
    for (const chip of chips) {
      const days = groups.get(chip.month) || [];
      if (!days.includes(chip.day)) days.push(chip.day);
      groups.set(chip.month, days);
    }
  }

  if (groups.size === 0 && rules.length === 0) {
    return (
      <div className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-warning/25 bg-warning/5 px-2.5 py-1 text-xs font-medium text-warning">
        <Icons.alert size={13} />
        Гарах өдөр дутуу
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {Array.from(groups.entries()).map(([month, days]) => (
        <div key={month} className="flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1">
          <span className="text-xs font-semibold text-brand">{month}</span>
          {[...days].sort((a, b) => calendarDaySortValue(a) - calendarDaySortValue(b)).map((day) => (
            <span
              key={day}
              className="flex h-6 min-w-6 items-center justify-center rounded-[6px] bg-surface-sunken px-1.5 text-xs font-semibold tabular-nums text-ink"
            >
              {day}
            </span>
          ))}
        </div>
      ))}
      {rules.map((rule) => (
        <span key={rule} className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-muted">
          {rule}
        </span>
      ))}
    </div>
  );
}

function getMissingHints(trip: TravelTrip): string[] {
  const hints: string[] = [];
  if (!trip.adult_price) hints.push("үнэ");
  if (!trip.departure_dates.length) hints.push("гарах өдөр");
  if (!trip.duration_text) hints.push("хугацаа");
  if (!tripHasPdf(trip)) hints.push("PDF");
  return hints;
}

function TripGroups({
  trips,
  onEdit,
  onDelete,
  onToggleVisible,
}: {
  trips: TravelTrip[];
  onEdit: (trip: TravelTrip) => void;
  onDelete: (trip: TravelTrip) => void;
  onToggleVisible: (trip: TravelTrip) => void;
}) {
  const groups = useMemo(() => {
    const meaningfulCategories = new Set(
      trips
        .map((trip) => trip.category?.trim())
        .filter((category): category is string => Boolean(category && category !== "Аялал")),
    );
    const collapseDefaultCategory = meaningfulCategories.size === 0;
    const map = new Map<string, TravelTrip[]>();
    for (const trip of trips) {
      const key = collapseDefaultCategory ? "Аяллууд" : trip.category?.trim() || "Ангилалгүй";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(trip);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b, "mn"));
  }, [trips]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  return (
    <div className="space-y-3">
      {groups.map(([category, items]) => {
        const isCollapsed = collapsed.has(category);
        const missingCount = items.filter((t) => getMissingHints(t).length > 0).length;
        return (
          <div key={category} className="rounded-xl border border-line bg-surface">
            <button
              type="button"
              onClick={() => toggle(category)}
              className="flex w-full items-center justify-between gap-2 rounded-t-xl px-3.5 py-2.5 text-left transition-colors hover:bg-surface-sunken/60"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-ink">{category}</span>
                <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
                  {items.length}
                </span>
                {missingCount > 0 && !isCollapsed && (
                  <span className="text-xs text-ink-subtle">· {missingCount} дутуу талбартай</span>
                )}
              </div>
              <Icons.chevronRight
                size={15}
                className={cx("shrink-0 text-ink-muted transition-transform", !isCollapsed && "rotate-90")}
              />
            </button>
            {!isCollapsed && (
              <div className="space-y-2 border-t border-line p-2.5">
                {items.map((trip) => (
                  <TripCard
                    key={trip.id}
                    trip={trip}
                    onEdit={() => onEdit(trip)}
                    onDelete={() => onDelete(trip)}
                    onToggleVisible={() => onToggleVisible(trip)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TripCard({
  trip,
  onEdit,
  onDelete,
  onToggleVisible,
}: {
  trip: TravelTrip;
  onEdit: () => void;
  onDelete: () => void;
  onToggleVisible: () => void;
}) {
  const isHidden = (trip.extra as Record<string, unknown>)?.customer_visible === false;
  const isPosterSynced = isPosterSyncedTrip(trip);
  const connection = tripConnectionDetails(trip);
  const hasPdf = tripHasPdf(trip);
  const facts: string[] = [];
  if (trip.seats_left != null || trip.seats_total != null) {
    facts.push(`Суудал: ${trip.seats_left ?? "?"}/${trip.seats_total ?? "?"}`);
  }
  const adultPrice = formatTripMoney(trip.adult_price, trip.currency);
  const childPrice = formatTripMoney(trip.child_price, trip.currency);
  if (adultPrice) facts.push(`Том хүн: ${adultPrice}`);
  if (childPrice) facts.push(`Хүүхэд: ${childPrice}`);
  if (trip.has_food != null) {
    facts.push(`Хоол: ${trip.has_food ? "багтсан" : "багтаагүй"}`);
  }
  if (trip.duration_text) facts.push(trip.duration_text);

  const missing = getMissingHints(trip);

  return (
    <Card className={cx("card-lift p-3.5", isHidden && "opacity-70")}>
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold text-ink">{trip.route_name || "—"}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {(trip.extra as Record<string, unknown>)?.needs_human_review === true && (
                <Badge tone="warning">Шалгах</Badge>
              )}
              {isHidden && <Badge tone="neutral">Нуусан</Badge>}
              {isPosterSynced && <Badge tone="brand">Poster sync</Badge>}
              <Badge tone={hasPdf ? "success" : "danger"}>
                {hasPdf ? "PDF бэлэн" : "PDF дутуу"}
              </Badge>
              <Badge tone={STATUS_TONE[trip.status]}>
                {STATUS_LABELS[trip.status]}
              </Badge>
            </div>
          </div>
          {facts.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {facts.map((fact, i) => (
                <span key={i} className="rounded-md bg-surface-sunken px-2 py-0.5 text-xs tabular-nums text-ink-muted">
                  {fact}
                </span>
              ))}
            </div>
          )}
          <DepartureCalendar dates={trip.departure_dates || []} />
          {isPosterSynced && (
            <div className="mt-2 rounded-md border border-brand/15 bg-brand-soft px-2.5 py-2 text-xs text-brand">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold">Холбоо:</span>
                <span className="rounded-[6px] bg-surface px-1.5 py-0.5 font-mono text-[11px]">{connection.posterId}</span>
                {connection.sourceFile && <span className="truncate text-brand/80">эх: {connection.sourceFile}</span>}
                {connection.pdfUrl && (
                  <a
                    href={connection.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto rounded-[6px] bg-surface px-2 py-0.5 font-semibold hover:underline"
                  >
                    PDF нээх
                  </a>
                )}
              </div>
            </div>
          )}
          {missing.length > 0 && (
            <p className="mt-1.5 text-xs text-ink-subtle">
              дутуу: {missing.join(" · ")}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-ink-subtle">
          Шинэчилсэн: {formatTime(trip.updated_at)}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            className={isHidden ? "text-success" : "text-ink-muted"}
            onClick={onToggleVisible}
            title={
              isHidden
                ? "Бот дахин энэ аяллын талаар хариулж эхэлнэ"
                : "Бот энэ аяллыг огт мэдэхгүй мэт хариулна (харилцагчид харагдахгүй)"
            }
          >
            {isHidden ? "Харуулах" : "Нуух"}
          </Button>
          <Button size="sm" variant="secondary" onClick={onEdit}>
            <Icons.edit size={15} />
            Засах
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            onClick={onDelete}
            title={isPosterSynced ? "Холбоотой постер хамт устна" : undefined}
          >
            <Icons.trash size={15} />
            Устгах
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------
   Leads tab — human-handoff requests & booking-intent captures
   ---------------------------------------------------------------- */
