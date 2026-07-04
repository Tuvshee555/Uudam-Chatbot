import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Icons,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  cx,
  useToast,
} from "@/components/ui";
import type {
  AIAction,
  AIProposal,
  AttachedFile,
  ChatButton,
  ChatMessage,
  ClarificationAnswer,
  ClarificationQuestion,
  ConflictItem,
  ControlState,
  DriveSyncDiagnostics,
  DriveSyncRecentFile,
  FlowRule,
  LeadStats,
  PageControlState,
  PauseRow,
  ProposalMsg,
  ReadinessReport,
  RecentRow,
  SettingsForm,
  StructuredRow,
  TravelBotSettings,
  TravelLead,
  TravelTrip,
} from "@/lib/adminTypes";
import {
  FIELD_LABELS,
  STATUS_LABELS,
  buildProposalClarifications,
  compactWarnings,
  describeAction,
  summarizeConflict,
} from "@/lib/adminProposalUtils";
import { SectionHeading, StructuredEditor } from "./AdminShared";
import {
  DURATIONS,
  HANDOFF_DURATION_CUSTOM,
  HANDOFF_DURATION_OPTIONS,
  MAX_AI_INPUT_CHARS,
  QUICK_ACTIONS,
  STATUS_TONE,
  asInt,
  conflictTone,
  driveSyncTone,
  formatBytes,
  formatMoney,
  formatTime,
  handoffDurationSelectValue,
  settingsToForm,
  shortId,
  splitLines,
  timeLeft,
  toStructuredRows,
} from "@/lib/adminUtils";

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
}) {
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [photoFilter, setPhotoFilter] = useState<"all" | "with" | "without">("all");
  const toast = useToast();

  const tripsWithoutPhotos = useMemo(
    () => trips.filter((t) => (t.photo_urls?.length || 0) === 0),
    [trips],
  );
  const tripsWithPhotos = useMemo(
    () => trips.filter((t) => (t.photo_urls?.length || 0) > 0),
    [trips],
  );
  const visibleTrips =
    photoFilter === "without" ? tripsWithoutPhotos :
    photoFilter === "with" ? tripsWithPhotos :
    trips;

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
          <div className="flex gap-2">
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

      <Card className="p-3.5">
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Маршрут эсвэл оператор хайх…"
              className="h-10 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle focus:border-brand"
            />
            <button
              type="button"
              onClick={onRefresh}
              aria-label="Шинэчлэх"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line-strong text-ink-muted hover:border-brand hover:text-brand"
            >
              {loading ? <Spinner /> : <Icons.refresh size={17} />}
            </button>
          </div>
          <div className="flex gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-10 flex-1 rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink focus:border-brand"
            >
              <option value="">Бүх төлөв</option>
              <option value="active">Идэвхтэй</option>
              <option value="cancelled">Цуцлагдсан</option>
              <option value="sold_out">Суудал дууссан</option>
              <option value="draft">Ноорог</option>
            </select>
            <button
              type="button"
              onClick={() => setPhotoFilter((f) => f === "all" ? "with" : f === "with" ? "without" : "all")}
              className={cx(
                "flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition",
                photoFilter === "with"
                  ? "border-brand bg-brand/10 text-brand"
                  : photoFilter === "without"
                  ? "border-warning bg-warning/10 text-warning"
                  : "border-line-strong bg-surface text-ink-muted hover:border-brand hover:text-brand",
              )}
              title="Зураг шүүлтүүр"
            >
              <Icons.image size={14} />
              {photoFilter === "with" ? "Зурагтай" : photoFilter === "without" ? "Зураггүй" : "Зураг"}
              <span className={cx("rounded-full px-1.5 py-0.5 tabular-nums",
                photoFilter === "with" ? "bg-brand/20" :
                photoFilter === "without" ? "bg-warning/20" : "bg-surface-sunken"
              )}>
                {photoFilter === "with" ? tripsWithPhotos.length : photoFilter === "without" ? tripsWithoutPhotos.length : trips.length}
              </span>
            </button>
            <Button onClick={onCreate} className="shrink-0">
              <Icons.plus size={16} />
              Шинэ аялал
            </Button>
          </div>
          {trips.length > 0 && (
            <div className="flex gap-2 border-t border-line pt-2">
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

      {tripsWithoutPhotos.length > 0 && photoFilter === "all" && (
        <div className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3.5 py-2.5 text-sm text-warning">
          <Icons.alert size={16} className="shrink-0" />
          <span>
            {tripsWithoutPhotos.length} аялалд зураг оруулаагүй байна.{" "}
            <button
              type="button"
              onClick={() => setPhotoFilter("without")}
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

function getMissingHints(trip: TravelTrip): string[] {
  const hints: string[] = [];
  if (!trip.adult_price) hints.push("үнэ");
  if (!trip.departure_dates.length) hints.push("гарах өдөр");
  if (!trip.duration_text) hints.push("хугацаа");
  const hasBrochure = trip.photo_urls.length > 0;
  if (!hasBrochure) hints.push("зураг");
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
    const map = new Map<string, TravelTrip[]>();
    for (const trip of trips) {
      const key = trip.category?.trim() || "Ангилалгүй";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(trip);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b, "mn"));
  }, [trips]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
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
              className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left"
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
  const facts: string[] = [];
  if (trip.seats_left != null || trip.seats_total != null) {
    facts.push(`Суудал: ${trip.seats_left ?? "?"}/${trip.seats_total ?? "?"}`);
  }
  if (trip.adult_price != null) {
    facts.push(`Том хүн: ${trip.adult_price.toLocaleString()}${trip.currency}`);
  }
  if (trip.child_price != null) {
    facts.push(`Хүүхэд: ${trip.child_price.toLocaleString()}${trip.currency}`);
  }
  if (trip.has_food != null) {
    facts.push(`Хоол: ${trip.has_food ? "багтсан" : "багтаагүй"}`);
  }
  if (trip.duration_text) facts.push(trip.duration_text);
  if (trip.departure_dates.length) {
    facts.push(`${trip.departure_dates.length} гарах өдөр`);
  }

  const missing = getMissingHints(trip);

  return (
    <Card className="p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{trip.route_name || "—"}</p>
          <p className="text-xs text-ink-subtle">
            {trip.operator_name}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {(trip.extra as Record<string, unknown>)?.needs_human_review === true && (
            <Badge tone="warning">Шалгах</Badge>
          )}
          {isHidden && <Badge tone="neutral">Нуусан</Badge>}
          <Badge tone={STATUS_TONE[trip.status]}>
            {STATUS_LABELS[trip.status]}
          </Badge>
        </div>
      </div>
      {facts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {facts.map((fact, i) => (
            <span key={i} className="rounded-md bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
              {fact}
            </span>
          ))}
        </div>
      )}
      {missing.length > 0 && (
        <p className="mt-1.5 text-xs text-ink-subtle">
          дутуу: {missing.join(" · ")}
        </p>
      )}
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
          <Button size="sm" variant="ghost" className="text-danger" onClick={onDelete}>
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
