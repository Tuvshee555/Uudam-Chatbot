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
  DocumentSenderSummary,
} from "@/lib/adminTypes";
import { formatTime, shortId } from "@/lib/adminUtils";

type SimpleDocumentCategory = "payment" | "passport" | "other";

const SIMPLE_CATEGORY_LABELS: Record<SimpleDocumentCategory, string> = {
  payment: "Төлбөр",
  passport: "Паспорт",
  other: "Бусад",
};

const SIMPLE_CATEGORY_ICONS: Record<SimpleDocumentCategory, string> = {
  payment: "💰",
  passport: "🛂",
  other: "📎",
};

const SIMPLE_CATEGORY_ORDER: SimpleDocumentCategory[] = ["payment", "passport", "other"];

function simpleCategory(category: CustomerDocumentCategory): SimpleDocumentCategory {
  if (category === "payment_screenshot") return "payment";
  if (category === "passport") return "passport";
  return "other";
}

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

function documentSearchText(doc: CustomerDocument): string {
  const rows = extractedRows(doc).flatMap((row) => [row.label, row.value]);
  return [
    doc.sender_id,
    doc.matched_trip_id,
    doc.matched_payment_id,
    doc.matched_payment_status,
    doc.matched_payment_amount,
    doc.matched_payment_customer_name,
    doc.matched_payment_trip_name,
    tripMatchName(doc),
    ...rows,
  ].map(compactValue).filter(Boolean).join(" ").toLowerCase();
}

const PAYMENT_STATUS_LABELS = {
  pending: "Төлбөр хүлээгдэж байна",
  paid: "Төлсөн",
  expired: "Хугацаа дууссан",
  cancelled: "Цуцлагдсан",
} as const;

const PAYMENT_STATUS_TONE = {
  pending: "warning",
  paid: "success",
  expired: "neutral",
  cancelled: "danger",
} as const;

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

function senderTitle(input: { display_name: string; sender_id: string }) {
  return input.display_name || `Хэрэглэгч …${shortId(input.sender_id)}`;
}

type EditFields = {
  summary: string;
  paymentAmount: string;
  paymentCurrency: string;
  paymentSender: string;
  paymentPhone: string;
  paymentDescription: string;
  paymentReference: string;
  paymentDate: string;
  passportName: string;
  passportNumber: string;
  passportBirthDate: string;
  passportExpiryDate: string;
};

function editFieldsFromDocument(doc: CustomerDocument): EditFields {
  const data = doc.extracted_json || {};
  const payment = data.payment && typeof data.payment === "object"
    ? (data.payment as Record<string, unknown>)
    : {};
  const passport = data.passport && typeof data.passport === "object"
    ? (data.passport as Record<string, unknown>)
    : {};
  return {
    summary: compactValue(data.summary),
    paymentAmount: compactValue(payment.amount),
    paymentCurrency: compactValue(payment.currency),
    paymentSender: compactValue(payment.sender_name),
    paymentPhone: compactValue(payment.phone),
    paymentDescription: compactValue(payment.description),
    paymentReference: compactValue(payment.reference),
    paymentDate: compactValue(payment.date),
    passportName: compactValue(passport.full_name),
    passportNumber: compactValue(passport.passport_number),
    passportBirthDate: compactValue(passport.date_of_birth),
    passportExpiryDate: compactValue(passport.expiry_date),
  };
}

function buildEditedJson(doc: CustomerDocument, fields: EditFields): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(doc.extracted_json || {}) };
  next.summary = fields.summary;
  if (simpleCategory(doc.category) === "payment") {
    next.payment = {
      ...((next.payment && typeof next.payment === "object") ? next.payment as Record<string, unknown> : {}),
      amount: fields.paymentAmount,
      currency: fields.paymentCurrency,
      sender_name: fields.paymentSender,
      phone: fields.paymentPhone,
      description: fields.paymentDescription,
      reference: fields.paymentReference,
      date: fields.paymentDate,
    };
  }
  if (simpleCategory(doc.category) === "passport") {
    next.passport = {
      ...((next.passport && typeof next.passport === "object") ? next.passport as Record<string, unknown> : {}),
      full_name: fields.passportName,
      passport_number: fields.passportNumber,
      date_of_birth: fields.passportBirthDate,
      expiry_date: fields.passportExpiryDate,
    };
  }
  return next;
}

function DocumentCard({
  doc,
  busyId,
  onEdit,
  onDelete,
  onRestore,
  onOpenPerson,
  showSender,
  showDeleted,
}: {
  doc: CustomerDocument;
  busyId: number | null;
  onEdit: (doc: CustomerDocument) => void;
  onDelete: (doc: CustomerDocument) => void;
  onRestore: (doc: CustomerDocument) => void;
  onOpenPerson?: (senderId: string) => void;
  showSender: boolean;
  showDeleted: boolean;
}) {
  const rows = extractedRows(doc);
  const imageUrl = doc.stored_url || doc.source_url;
  const matchedTrip = tripMatchName(doc);
  const bucket = simpleCategory(doc.category);
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
            <Badge tone="neutral">
              {SIMPLE_CATEGORY_ICONS[bucket]} {SIMPLE_CATEGORY_LABELS[bucket]}
            </Badge>
            {matchedTrip && <Badge tone="success">✈️ {matchedTrip}</Badge>}
            {doc.matched_payment_id && (
              <Badge tone="success">Төлбөр #{doc.matched_payment_id}</Badge>
            )}
            {doc.matched_payment_status && (
              <Badge tone={PAYMENT_STATUS_TONE[doc.matched_payment_status]}>
                {PAYMENT_STATUS_LABELS[doc.matched_payment_status]}
                {typeof doc.matched_payment_amount === "number"
                  ? ` · ${doc.matched_payment_amount.toLocaleString()}₮`
                  : ""}
              </Badge>
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
              variant="secondary"
              disabled={busyId === doc.id || showDeleted}
              onClick={() => onEdit(doc)}
            >
              <Icons.edit size={14} />
              Засах
            </Button>
            {showDeleted ? (
              <Button
                size="sm"
                variant="success"
                disabled={busyId === doc.id}
                loading={busyId === doc.id}
                onClick={() => onRestore(doc)}
              >
                <Icons.refresh size={14} />
                Сэргээх
              </Button>
            ) : (
              <Button
                size="sm"
                variant="danger"
                disabled={busyId === doc.id}
                loading={busyId === doc.id}
                onClick={() => onDelete(doc)}
              >
                <Icons.trash size={14} />
                Устгах
              </Button>
            )}
          </div>
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
  const [category, setCategory] = useState<SimpleDocumentCategory | "all">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showDeleted, setShowDeleted] = useState(false);
  const [editing, setEditing] = useState<CustomerDocument | null>(null);
  const [editFields, setEditFields] = useState<EditFields>(() => editFieldsFromDocument({ extracted_json: {} } as CustomerDocument));

  const loadSenders = useCallback(async () => {
    setSendersLoading(true);
    try {
      const params = new URLSearchParams({ group: "senders" });
      if (dateFrom) params.set("from", dateFrom);
      if (dateTo) params.set("to", dateTo);
      if (showDeleted) params.set("deleted", "true");
      const res = await apiFetch(`/api/admin/customer-documents?${params.toString()}`);
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
  }, [apiFetch, dateFrom, dateTo, showDeleted, toast]);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams(
        selectedSender
          ? { sender_id: selectedSender, status: "all", limit: "300" }
          : { status: "all", category: "all", limit: "300" },
      );
      if (dateFrom) params.set("from", dateFrom);
      if (dateTo) params.set("to", dateTo);
      if (showDeleted) params.set("deleted", "true");
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
  }, [apiFetch, dateFrom, dateTo, selectedSender, showDeleted, toast]);

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
        sender.sender_id.includes(query) ||
        String(sender.total).includes(query) ||
        Object.values(sender.by_category).some((count) => String(count).includes(query)),
    );
  }, [search, senders]);

  const visibleDocuments = useMemo(
    () => {
      const query = search.trim().toLowerCase();
      return documents.filter((doc) => {
        if (category !== "all" && simpleCategory(doc.category) !== category) return false;
        if (!query) return true;
        return documentSearchText(doc).includes(query);
      });
    },
    [category, documents, search],
  );

  const documentsByCategory = useMemo(() => {
    const groups = new Map<SimpleDocumentCategory, CustomerDocument[]>();
    for (const doc of visibleDocuments) {
      const bucket = simpleCategory(doc.category);
      const list = groups.get(bucket) || [];
      list.push(doc);
      groups.set(bucket, list);
    }
    return groups;
  }, [visibleDocuments]);

  const selectedSenderSummary = useMemo(
    () => senders.find((sender) => sender.sender_id === selectedSender) || null,
    [selectedSender, senders],
  );

  async function deleteDocument(doc: CustomerDocument) {
    setBusyId(doc.id);
    try {
      const res = await apiFetch(`/api/admin/customer-documents?id=${encodeURIComponent(String(doc.id))}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("failed");
      setDocuments((prev) => prev.filter((item) => item.id !== doc.id));
      onChanged?.();
      toast.success("Зураг устгагдлаа.");
    } catch {
      toast.error("Зураг устгаж чадсангүй.");
    } finally {
      setBusyId(null);
    }
  }

  async function restoreDocument(doc: CustomerDocument) {
    setBusyId(doc.id);
    try {
      const res = await apiFetch("/api/admin/customer-documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: doc.id, restore: true }),
      });
      if (!res.ok) throw new Error("failed");
      setDocuments((prev) => prev.filter((item) => item.id !== doc.id));
      onChanged?.();
      toast.success("Зураг сэргээгдлээ.");
    } catch {
      toast.error("Зураг сэргээж чадсангүй.");
    } finally {
      setBusyId(null);
    }
  }

  function openEdit(doc: CustomerDocument) {
    setEditing(doc);
    setEditFields(editFieldsFromDocument(doc));
  }

  async function saveEdit() {
    if (!editing) return;
    setBusyId(editing.id);
    try {
      const res = await apiFetch("/api/admin/customer-documents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editing.id,
          extracted_json: buildEditedJson(editing, editFields),
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

  function setEditField(key: keyof EditFields, value: string) {
    setEditFields((prev) => ({ ...prev, [key]: value }));
  }

  const showPeopleList = view === "people" && !selectedSender;
  const showPersonDetail = view === "people" && Boolean(selectedSender);
  const editingBucket = editing ? simpleCategory(editing.category) : "other";

  return (
    <div className="space-y-3">
      <Card className="p-3.5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="font-semibold text-ink">Ирсэн зургууд</p>
            <p className="text-xs text-ink-subtle">
              Хэрэглэгчээс ирсэн бүх зураг автоматаар хадгалагдана. Хэрэггүй бол устгахад л болно.
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
              <Select
                value={category}
                onChange={(e) =>
                  setCategory(e.target.value as SimpleDocumentCategory | "all")
                }
                className="w-36"
              >
                <option value="all">Бүх зураг</option>
                {SIMPLE_CATEGORY_ORDER.map((key) => (
                  <option key={key} value={key}>
                    {SIMPLE_CATEGORY_ICONS[key]} {SIMPLE_CATEGORY_LABELS[key]}
                  </option>
                ))}
              </Select>
            )}
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-36"
              aria-label="Эхлэх өдөр"
            />
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-36"
              aria-label="Дуусах өдөр"
            />
            <button
              type="button"
              onClick={() => setShowDeleted((value) => !value)}
              className={cx(
                "h-10 rounded-md border px-3 text-xs font-semibold transition-colors",
                showDeleted
                  ? "border-danger bg-danger text-white"
                  : "border-line-strong bg-surface text-ink-muted hover:border-brand hover:text-brand",
              )}
            >
              Устгасан
            </button>
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

      <Input
        placeholder={
          view === "people" && !selectedSender
            ? "Нэр, ID, зурагны тоогоор хайх..."
            : "Нэр, утас, дүн, журнал №, паспорт, аялал, ID-аар хайх..."
        }
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {showPeopleList && (
        <>
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
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {SIMPLE_CATEGORY_ORDER.map((key) => {
                        const count = key === "payment"
                          ? sender.by_category.payment_screenshot || 0
                          : key === "passport"
                            ? sender.by_category.passport || 0
                            : (sender.by_category.travel_document || 0) +
                              (sender.by_category.booking_code || 0) +
                              (sender.by_category.trip_screenshot || 0) +
                              (sender.by_category.other || 0);
                        return count ? (
                          <span
                            key={key}
                            className="rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-[11px] text-ink-muted"
                          >
                            {SIMPLE_CATEGORY_ICONS[key]} {SIMPLE_CATEGORY_LABELS[key]}: {count}
                          </span>
                        ) : null;
                      })}
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
            SIMPLE_CATEGORY_ORDER.map((key) => {
              const docs = documentsByCategory.get(key);
              if (!docs || docs.length === 0) return null;
              return (
                <div key={key} className="space-y-2">
                  <p className="text-sm font-semibold text-ink">
                    {SIMPLE_CATEGORY_ICONS[key]} {SIMPLE_CATEGORY_LABELS[key]}{" "}
                    <span className="font-normal text-ink-subtle">({docs.length})</span>
                  </p>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {docs.map((doc) => (
                      <DocumentCard
                        key={doc.id}
                        doc={doc}
                        busyId={busyId}
                        onEdit={openEdit}
                        onDelete={(target) => void deleteDocument(target)}
                        onRestore={(target) => void restoreDocument(target)}
                        showSender={false}
                        showDeleted={showDeleted}
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
          {!loading && visibleDocuments.length === 0 ? (
            <Card className="p-4">
              <EmptyState
                icon={<Icons.image size={26} />}
                title="Зурагтай бичлэг алга"
                description="Шинэ паспорт, төлбөрийн баримт эсвэл аяллын зураг ирвэл энд харагдана."
              />
            </Card>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {visibleDocuments.map((doc) => (
                <DocumentCard
                  key={doc.id}
                  doc={doc}
                  busyId={busyId}
                  onEdit={openEdit}
                  onDelete={(target) => void deleteDocument(target)}
                  onRestore={(target) => void restoreDocument(target)}
                  onOpenPerson={openPerson}
                  showSender
                  showDeleted={showDeleted}
                />
              ))}
            </div>
          )}
          {loading && visibleDocuments.length === 0 && (
            <div className="flex justify-center py-8">
              <Spinner className="h-6 w-6 text-brand" />
            </div>
          )}
        </>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title="Зургийн мэдээлэл засах"
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
          {editing && (
            <div className="flex items-center gap-2 rounded-md border border-line bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
              <span>{SIMPLE_CATEGORY_ICONS[editingBucket]}</span>
              <span>{SIMPLE_CATEGORY_LABELS[editingBucket]}</span>
              <span className="text-ink-subtle">#{editing.id}</span>
            </div>
          )}
          <Input
            label="Товч"
            value={editFields.summary}
            onChange={(e) => setEditField("summary", e.target.value)}
          />
          {editingBucket === "payment" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Дүн"
                value={editFields.paymentAmount}
                onChange={(e) => setEditField("paymentAmount", e.target.value)}
              />
              <Input
                label="Валют"
                value={editFields.paymentCurrency}
                onChange={(e) => setEditField("paymentCurrency", e.target.value)}
              />
              <Input
                label="Илгээгч"
                value={editFields.paymentSender}
                onChange={(e) => setEditField("paymentSender", e.target.value)}
              />
              <Input
                label="Утас"
                value={editFields.paymentPhone}
                onChange={(e) => setEditField("paymentPhone", e.target.value)}
              />
              <Input
                label="Журнал №"
                value={editFields.paymentReference}
                onChange={(e) => setEditField("paymentReference", e.target.value)}
              />
              <Input
                label="Төлсөн огноо"
                value={editFields.paymentDate}
                onChange={(e) => setEditField("paymentDate", e.target.value)}
              />
              <div className="sm:col-span-2">
                <Textarea
                  label="Гүйлгээний утга"
                  rows={3}
                  value={editFields.paymentDescription}
                  onChange={(e) => setEditField("paymentDescription", e.target.value)}
                />
              </div>
            </div>
          )}
          {editingBucket === "passport" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Нэр"
                value={editFields.passportName}
                onChange={(e) => setEditField("passportName", e.target.value)}
              />
              <Input
                label="Паспорт №"
                value={editFields.passportNumber}
                onChange={(e) => setEditField("passportNumber", e.target.value)}
              />
              <Input
                label="Төрсөн огноо"
                value={editFields.passportBirthDate}
                onChange={(e) => setEditField("passportBirthDate", e.target.value)}
              />
              <Input
                label="Дуусах огноо"
                value={editFields.passportExpiryDate}
                onChange={(e) => setEditField("passportExpiryDate", e.target.value)}
              />
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
