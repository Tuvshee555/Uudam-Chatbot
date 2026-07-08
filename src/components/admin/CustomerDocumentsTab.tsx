import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icons,
  Input,
  Modal,
  Select,
  Spinner,
  cx,
  Textarea,
  useToast,
} from "@/components/ui";
import type {
  CustomerDocument,
  CustomerDocumentCategory,
  CustomerDocumentStatus,
  DocumentSenderSummary,
} from "@/lib/adminTypes";
import { formatTime, shortId } from "@/lib/adminUtils";

const CATEGORY_LABELS: Record<CustomerDocumentCategory, string> = {
  payment_screenshot: "Төлбөрийн баримт",
  passport: "Паспорт",
  travel_document: "Бичиг баримт",
  booking_code: "Код / нууц үг",
  trip_screenshot: "Аяллын зураг",
  other: "Бусад",
};

const CATEGORY_ICONS: Record<CustomerDocumentCategory, string> = {
  payment_screenshot: "💰",
  passport: "🛂",
  travel_document: "📄",
  booking_code: "🔑",
  trip_screenshot: "✈️",
  other: "📎",
};

// Fixed display order: money first, identity documents next, questions last.
const CATEGORY_ORDER: CustomerDocumentCategory[] = [
  "payment_screenshot",
  "passport",
  "travel_document",
  "booking_code",
  "trip_screenshot",
  "other",
];

const STATUS_LABELS: Record<CustomerDocumentStatus, string> = {
  needs_review: "Шалгах",
  verified: "Баталгаажсан",
  wrong_extraction: "Буруу уншсан",
  duplicate: "Давхардсан",
  attached_to_booking: "Захиалгад холбосон",
  reviewed: "Шалгасан",
  ignored: "Алгассан",
};

const STATUS_TONE: Record<CustomerDocumentStatus, "warning" | "success" | "neutral" | "danger"> = {
  needs_review: "warning",
  verified: "success",
  wrong_extraction: "danger",
  duplicate: "neutral",
  attached_to_booking: "success",
  reviewed: "success",
  ignored: "neutral",
};

function compactValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map(compactValue).filter(Boolean).join(", ");
  }
  if (typeof value === "object") return "";
  return String(value).trim();
}

function tripMatchName(doc: CustomerDocument): string {
  const match = doc.extracted_json?.trip_match;
  if (!match || typeof match !== "object") return "";
  return compactValue((match as Record<string, unknown>).route_name);
}

function extractedRows(doc: CustomerDocument) {
  const data = doc.extracted_json || {};
  const rows: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown) => {
    const text = compactValue(value);
    if (text) rows.push({ label, value: text });
  };
  add("Товч", data.summary);
  const passport = data.passport && typeof data.passport === "object"
    ? (passportRecord(data.passport))
    : {};
  add("Нэр", passport.full_name);
  add("Паспорт", passport.passport_number);
  add("Төрсөн огноо", passport.date_of_birth);
  add("Дуусах огноо", passport.expiry_date);
  const trip = data.trip && typeof data.trip === "object"
    ? (data.trip as Record<string, unknown>)
    : {};
  add("Аялал", trip.title);
  add("Чиглэл", trip.destination);
  add("Огноо", trip.departure_dates);
  add("Үнэ", trip.price_text);
  const payment = data.payment && typeof data.payment === "object"
    ? (data.payment as Record<string, unknown>)
    : {};
  add("Дүн", [compactValue(payment.amount), compactValue(payment.currency)].filter(Boolean).join(" "));
  add("Илгээгч", payment.sender_name);
  add("Утас (гүйлгээ)", payment.phone);
  add("Гүйлгээний утга", payment.description);
  add("Журнал №", payment.reference);
  add("Төлсөн огноо", payment.date);
  const booking = data.booking && typeof data.booking === "object"
    ? (data.booking as Record<string, unknown>)
    : {};
  add("Код", booking.code);
  add("Аяллын нэр", booking.trip_name);
  add("Зорчигч", booking.traveler_name);
  add("Утас", booking.phone);
  return rows.slice(0, 10);
}

function passportRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function confidenceLabel(value: number) {
  const score = Number.isFinite(value) ? value : 0;
  if (score >= 0.82) return { label: "AI өндөр", tone: "success" as const };
  if (score >= 0.55) return { label: "AI дунд", tone: "warning" as const };
  return { label: "AI бага — шалгах!", tone: "danger" as const };
}

function senderTitle(input: { display_name: string; sender_id: string }) {
  return input.display_name || `Хэрэглэгч …${shortId(input.sender_id)}`;
}

function DocumentCard({
  doc,
  busyId,
  onStatus,
  onEdit,
  onOpenPerson,
  showSender,
}: {
  doc: CustomerDocument;
  busyId: number | null;
  onStatus: (doc: CustomerDocument, status: CustomerDocumentStatus) => void;
  onEdit: (doc: CustomerDocument) => void;
  onOpenPerson?: (senderId: string) => void;
  showSender: boolean;
}) {
  const rows = extractedRows(doc);
  const imageUrl = doc.stored_url || doc.source_url;
  const matchedTrip = tripMatchName(doc);
  const confidence = confidenceLabel(doc.confidence);
  return (
    <Card className="overflow-hidden p-0">
      <div className="grid gap-0 sm:grid-cols-[180px_1fr]">
        <a
          href={imageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block bg-surface-sunken"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt=""
            className="h-48 w-full object-cover sm:h-full"
            loading="lazy"
          />
        </a>
        <div className="min-w-0 p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[doc.status]}>{STATUS_LABELS[doc.status]}</Badge>
            <Badge tone="neutral">
              {CATEGORY_ICONS[doc.category]} {CATEGORY_LABELS[doc.category]}
            </Badge>
            <Badge tone={confidence.tone}>{confidence.label}</Badge>
            {matchedTrip && <Badge tone="success">✈️ {matchedTrip}</Badge>}
            {doc.duplicate_of_id && <Badge tone="neutral">Давхардсан #{doc.duplicate_of_id}</Badge>}
            {doc.matched_payment_id && (
              <Badge tone="success">Төлбөр #{doc.matched_payment_id}</Badge>
            )}
            <span className="text-xs text-ink-subtle">{formatTime(doc.created_at)}</span>
          </div>
          {showSender && (
            <button
              type="button"
              onClick={() => onOpenPerson?.(doc.sender_id)}
              className="mt-2 text-xs text-brand hover:underline"
            >
              Хэрэглэгч …{shortId(doc.sender_id)} — бүх зургийг харах
            </button>
          )}
          <div className="mt-3 space-y-1.5">
            {rows.length === 0 ? (
              <p className="rounded-md border border-line bg-surface-sunken px-2.5 py-2 text-xs text-ink-subtle">
                Уншигдсан талбар алга. Гараар шалгана уу.
              </p>
            ) : (
              rows.map((row) => (
                <div key={row.label} className="grid grid-cols-[110px_1fr] gap-2 text-xs">
                  <span className="text-ink-subtle">{row.label}</span>
                  <span className="min-w-0 break-words font-medium text-ink">{row.value}</span>
                </div>
              ))
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="success"
              disabled={busyId === doc.id || doc.status === "verified"}
              loading={busyId === doc.id}
              onClick={() => onStatus(doc, "verified")}
            >
              <Icons.check size={14} />
              Баталгаажуулах
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busyId === doc.id}
              onClick={() => onEdit(doc)}
            >
              <Icons.edit size={14} />
              Засах
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busyId === doc.id || doc.status === "wrong_extraction"}
              onClick={() => onStatus(doc, "wrong_extraction")}
            >
              Буруу
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busyId === doc.id || doc.status === "ignored"}
              onClick={() => onStatus(doc, "ignored")}
            >
              Алгасах
            </Button>
          </div>
          {(doc.category === "passport" || doc.category === "booking_code") && (
            <p className="mt-2 text-[11px] text-danger">
              Нууцлалтай мэдээлэл — баталгаажуулахаас өмнө заавал зурагтай нь тулгаж шалгана уу.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

export function CustomerDocumentsTab({
  apiFetch,
  onChanged,
}: {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [view, setView] = useState<"people" | "all">("people");
  const [senders, setSenders] = useState<DocumentSenderSummary[]>([]);
  const [sendersLoading, setSendersLoading] = useState(false);
  const [selectedSender, setSelectedSender] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [documents, setDocuments] = useState<CustomerDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [status, setStatus] = useState<CustomerDocumentStatus | "all">("needs_review");
  const [category, setCategory] = useState<CustomerDocumentCategory | "all">("all");
  const [editing, setEditing] = useState<CustomerDocument | null>(null);
  const [editJson, setEditJson] = useState("");
  const [editStatus, setEditStatus] = useState<CustomerDocumentStatus>("needs_review");

  const loadSenders = useCallback(async () => {
    setSendersLoading(true);
    try {
      const res = await apiFetch("/api/admin/customer-documents?group=senders");
      const json = (await res.json().catch(() => ({}))) as {
        senders?: DocumentSenderSummary[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "load_failed");
      setSenders(Array.isArray(json.senders) ? json.senders : []);
    } catch {
      toast.error("Хэрэглэгчдийн жагсаалтыг ачаалж чадсангүй.");
    } finally {
      setSendersLoading(false);
    }
  }, [apiFetch, toast]);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams(
        selectedSender
          ? { sender_id: selectedSender, status: "all", limit: "120" }
          : { status, category, limit: "120" },
      );
      const res = await apiFetch(`/api/admin/customer-documents?${params.toString()}`);
      const json = (await res.json().catch(() => ({}))) as {
        documents?: CustomerDocument[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "load_failed");
      setDocuments(Array.isArray(json.documents) ? json.documents : []);
    } catch {
      toast.error("Зургаар ирсэн бичиг баримтуудыг ачаалж чадсангүй.");
    } finally {
      setLoading(false);
    }
  }, [apiFetch, category, selectedSender, status, toast]);

  useEffect(() => {
    if (view === "people" && !selectedSender) {
      void loadSenders();
    } else {
      void loadDocuments();
    }
  }, [view, selectedSender, loadSenders, loadDocuments]);

  const filteredSenders = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return senders;
    return senders.filter(
      (sender) =>
        sender.display_name.toLowerCase().includes(query) ||
        sender.sender_id.includes(query),
    );
  }, [search, senders]);

  const documentsByCategory = useMemo(() => {
    const groups = new Map<CustomerDocumentCategory, CustomerDocument[]>();
    for (const doc of documents) {
      const list = groups.get(doc.category) || [];
      list.push(doc);
      groups.set(doc.category, list);
    }
    return groups;
  }, [documents]);

  const selectedSenderSummary = useMemo(
    () => senders.find((sender) => sender.sender_id === selectedSender) || null,
    [selectedSender, senders],
  );

  async function updateStatus(doc: CustomerDocument, nextStatus: CustomerDocumentStatus) {
    setBusyId(doc.id);
    try {
      const res = await apiFetch("/api/admin/customer-documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: doc.id, status: nextStatus }),
      });
      if (!res.ok) throw new Error("failed");
      setDocuments((prev) =>
        prev.map((item) => (item.id === doc.id ? { ...item, status: nextStatus } : item)),
      );
      onChanged?.();
      toast.success("Төлөв шинэчлэгдлээ.");
    } catch {
      toast.error("Төлөв шинэчилж чадсангүй.");
    } finally {
      setBusyId(null);
    }
  }

  function openEdit(doc: CustomerDocument) {
    setEditing(doc);
    setEditStatus(doc.status);
    setEditJson(JSON.stringify(doc.extracted_json || {}, null, 2));
  }

  async function saveEdit() {
    if (!editing) return;
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(editJson);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("object required");
      }
      parsed = value as Record<string, unknown>;
    } catch {
      toast.error("JSON бүтэц буруу байна.");
      return;
    }
    setBusyId(editing.id);
    try {
      const res = await apiFetch("/api/admin/customer-documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editing.id,
          status: editStatus,
          extracted_json: parsed,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        document?: CustomerDocument;
        error?: string;
      };
      if (!res.ok || !json.document) throw new Error(json.error || "failed");
      setDocuments((prev) =>
        prev.map((item) => (item.id === editing.id ? (json.document as CustomerDocument) : item)),
      );
      setEditing(null);
      onChanged?.();
      toast.success("Засвар хадгалагдлаа.");
    } catch {
      toast.error("Засвар хадгалж чадсангүй.");
    } finally {
      setBusyId(null);
    }
  }

  function openPerson(senderId: string) {
    setSelectedSender(senderId);
    setView("people");
  }

  const showPeopleList = view === "people" && !selectedSender;
  const showPersonDetail = view === "people" && Boolean(selectedSender);

  return (
    <div className="space-y-3">
      <Card className="p-3.5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="font-semibold text-ink">Ирсэн зургууд</p>
            <p className="text-xs text-ink-subtle">
              Бүх зураг автоматаар хадгалагдаж, AI ангилдаг — доорх төлөв нь зөвхөн шалгалтын явц.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-line-strong p-0.5">
              <button
                type="button"
                onClick={() => {
                  setSelectedSender(null);
                  setView("people");
                }}
                className={cx(
                  "rounded px-3 py-1.5 text-xs font-medium",
                  view === "people" ? "bg-brand text-white" : "text-ink-muted hover:text-ink",
                )}
              >
                Хүмүүс
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedSender(null);
                  setView("all");
                }}
                className={cx(
                  "rounded px-3 py-1.5 text-xs font-medium",
                  view === "all" ? "bg-brand text-white" : "text-ink-muted hover:text-ink",
                )}
              >
                Бүх зураг
              </button>
            </div>
            {view === "all" && (
              <>
                <Select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as CustomerDocumentStatus | "all")}
                  className="w-36"
                >
                  <option value="needs_review">Шалгах</option>
                  <option value="verified">Баталгаажсан</option>
                  <option value="wrong_extraction">Буруу уншсан</option>
                  <option value="duplicate">Давхардсан</option>
                  <option value="attached_to_booking">Захиалгад холбосон</option>
                  <option value="reviewed">Шалгасан</option>
                  <option value="ignored">Алгассан</option>
                  <option value="all">Бүгд</option>
                </Select>
                <Select
                  value={category}
                  onChange={(e) =>
                    setCategory(e.target.value as CustomerDocumentCategory | "all")
                  }
                  className="w-44"
                >
                  <option value="all">Бүх төрөл</option>
                  {CATEGORY_ORDER.map((key) => (
                    <option key={key} value={key}>
                      {CATEGORY_ICONS[key]} {CATEGORY_LABELS[key]}
                    </option>
                  ))}
                </Select>
              </>
            )}
            <button
              type="button"
              onClick={() => (showPeopleList ? void loadSenders() : void loadDocuments())}
              aria-label="Шинэчлэх"
              className="flex h-10 w-10 items-center justify-center rounded-md border border-line-strong text-ink-muted hover:border-brand hover:text-brand"
            >
              {sendersLoading || loading ? <Spinner /> : <Icons.refresh size={17} />}
            </button>
          </div>
        </div>
      </Card>

      {showPeopleList && (
        <>
          <Input
            placeholder="Нэр эсвэл ID-гаар хайх…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {sendersLoading && senders.length === 0 ? (
            <div className="flex justify-center py-8">
              <Spinner className="h-6 w-6 text-brand" />
            </div>
          ) : filteredSenders.length === 0 ? (
            <Card className="p-4">
              <EmptyState
                icon={<Icons.image size={26} />}
                title="Зураг илгээсэн хэрэглэгч алга"
                description="Хэрэглэгч зураг илгээмэгц энд автоматаар бүртгэгдэнэ."
              />
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredSenders.map((sender) => (
                <button
                  key={sender.sender_id}
                  type="button"
                  onClick={() => setSelectedSender(sender.sender_id)}
                  className="text-left"
                >
                  <Card className="h-full p-3.5 transition-colors hover:border-brand">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand">
                          {(sender.display_name || "?").slice(0, 1).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-ink">
                            {senderTitle(sender)}
                          </p>
                          <p className="text-[11px] text-ink-subtle">
                            {sender.total} зураг · {formatTime(sender.last_at)}
                          </p>
                        </div>
                      </div>
                      {sender.needs_review > 0 && (
                        <Badge tone="warning">{sender.needs_review} шалгах</Badge>
                      )}
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {CATEGORY_ORDER.map((key) =>
                        sender.by_category[key] ? (
                          <span
                            key={key}
                            className="rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-[11px] text-ink-muted"
                          >
                            {CATEGORY_ICONS[key]} {CATEGORY_LABELS[key]}: {sender.by_category[key]}
                          </span>
                        ) : null,
                      )}
                    </div>
                  </Card>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {showPersonDetail && (
        <>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setSelectedSender(null)}>
              ← Буцах
            </Button>
            <p className="text-sm font-semibold text-ink">
              {selectedSenderSummary
                ? senderTitle(selectedSenderSummary)
                : `Хэрэглэгч …${shortId(selectedSender || "")}`}
            </p>
          </div>
          {loading && documents.length === 0 ? (
            <div className="flex justify-center py-8">
              <Spinner className="h-6 w-6 text-brand" />
            </div>
          ) : documents.length === 0 ? (
            <Card className="p-4">
              <EmptyState
                icon={<Icons.image size={26} />}
                title="Зураг алга"
                description="Энэ хэрэглэгчээс ирсэн зураг олдсонгүй."
              />
            </Card>
          ) : (
            CATEGORY_ORDER.map((key) => {
              const docs = documentsByCategory.get(key);
              if (!docs || docs.length === 0) return null;
              return (
                <div key={key} className="space-y-2">
                  <p className="text-sm font-semibold text-ink">
                    {CATEGORY_ICONS[key]} {CATEGORY_LABELS[key]}{" "}
                    <span className="font-normal text-ink-subtle">({docs.length})</span>
                  </p>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {docs.map((doc) => (
                      <DocumentCard
                        key={doc.id}
                        doc={doc}
                        busyId={busyId}
                        onStatus={(target, next) => void updateStatus(target, next)}
                        onEdit={openEdit}
                        showSender={false}
                      />
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </>
      )}

      {view === "all" && (
        <>
          {!loading && documents.length === 0 ? (
            <Card className="p-4">
              <EmptyState
                icon={<Icons.image size={26} />}
                title="Зурагтай бичлэг алга"
                description="Шинэ паспорт, төлбөрийн баримт эсвэл аяллын зураг ирвэл энд харагдана."
              />
            </Card>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {documents.map((doc) => (
                <DocumentCard
                  key={doc.id}
                  doc={doc}
                  busyId={busyId}
                  onStatus={(target, next) => void updateStatus(target, next)}
                  onEdit={openEdit}
                  onOpenPerson={openPerson}
                  showSender
                />
              ))}
            </div>
          )}
          {loading && documents.length === 0 && (
            <div className="flex justify-center py-8">
              <Spinner className="h-6 w-6 text-brand" />
            </div>
          )}
        </>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title="Уншсан мэдээлэл засах"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Болих
            </Button>
            <Button
              onClick={() => void saveEdit()}
              loading={busyId === editing?.id}
              disabled={!editing}
            >
              Хадгалах
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Select
            label="Төлөв"
            value={editStatus}
            onChange={(e) => setEditStatus(e.target.value as CustomerDocumentStatus)}
          >
            {(Object.entries(STATUS_LABELS) as [CustomerDocumentStatus, string][]).map(
              ([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ),
            )}
          </Select>
          <Textarea
            label="Extracted JSON"
            rows={14}
            value={editJson}
            onChange={(e) => setEditJson(e.target.value)}
          />
          <p className="text-xs text-ink-subtle">
            Паспорт, код, төлбөрийн мэдээлэл засахдаа зөвхөн зурагтай нь тулгаж баталгаажуулна уу.
          </p>
        </div>
      </Modal>
    </div>
  );
}
