import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Icons,
  Input,
  Modal,
  Select,
  Spinner,
  cx,
  Textarea,
  useToast,
} from "@/components/ui";
import { TabHeader } from "./AdminShared";
import type {
  CustomerDocument,
  CustomerDocumentCategory,
  DocumentSenderSummary,
} from "@/lib/adminTypes";
import { formatTime, shortId } from "@/lib/adminUtils";

const DOCUMENT_CATEGORY_LABELS: Record<CustomerDocumentCategory, string> = {
  payment_screenshot: "Төлбөрийн баримт",
  passport: "Паспорт",
  booking_code: "Захиалгын код",
  trip_screenshot: "Аяллын screenshot",
  travel_document: "Бичиг баримт",
  other: "Бусад",
};

const DOCUMENT_CATEGORY_SHORT_LABELS: Record<CustomerDocumentCategory, string> = {
  payment_screenshot: "Төлбөр",
  passport: "Паспорт",
  booking_code: "Код",
  trip_screenshot: "Аялал",
  travel_document: "Баримт",
  other: "Бусад",
};

const DOCUMENT_CATEGORY_ICONS: Record<CustomerDocumentCategory, string> = {
  payment_screenshot: "💰",
  passport: "🛂",
  booking_code: "🔑",
  trip_screenshot: "🧭",
  travel_document: "📄",
  other: "📎",
};

const DOCUMENT_CATEGORY_ORDER: CustomerDocumentCategory[] = [
  "payment_screenshot",
  "passport",
  "booking_code",
  "trip_screenshot",
  "travel_document",
  "other",
];

function documentCategory(category: CustomerDocumentCategory): CustomerDocumentCategory {
  return DOCUMENT_CATEGORY_ORDER.includes(category) ? category : "other";
}

function compactValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map(compactValue).filter(Boolean).join(", ");
  }
  if (typeof value === "object") return "";
  return String(value).trim();
}

/** "11860000.00 MNT" → "11,860,000₮"; non-MNT currencies keep their code. */
function formatAmount(amount: unknown, currency?: unknown): string {
  const raw = compactValue(amount);
  if (!raw) return "";
  const cur = compactValue(currency).toUpperCase();
  const n = parseFloat(raw.replace(/[\s,]/g, ""));
  if (!Number.isFinite(n)) return [raw, cur].filter(Boolean).join(" ");
  const formatted = n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (!cur || cur === "MNT" || cur === "₮") return `${formatted}₮`;
  return `${formatted} ${cur}`;
}

function tripMatchName(doc: CustomerDocument): string {
  const match = doc.extracted_json?.trip_match;
  if (!match || typeof match !== "object") return "";
  return compactValue((match as Record<string, unknown>).route_name);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The one fact the agency cares about first, per document kind. */
function documentTitle(doc: CustomerDocument): string {
  const data = doc.extracted_json || {};
  const category = documentCategory(doc.category);
  if (category === "payment_screenshot") {
    const payment = record(data.payment);
    return (
      formatAmount(payment.amount, payment.currency) ||
      compactValue(data.summary) ||
      "Төлбөрийн баримт"
    );
  }
  if (category === "passport") {
    const passport = record(data.passport);
    return compactValue(passport.full_name) || "Паспортын зураг";
  }
  if (category === "booking_code") {
    const booking = record(data.booking);
    return compactValue(booking.code) || compactValue(booking.trip_name) || "Захиалгын код";
  }
  if (category === "trip_screenshot") {
    const trip = record(data.trip);
    return tripMatchName(doc) || compactValue(trip.title) || compactValue(trip.destination) || "Аяллын screenshot";
  }
  if (category === "travel_document") {
    return compactValue(data.summary) || compactValue(data.visible_text) || "Бичиг баримт";
  }
  return (
    compactValue(data.summary) ||
    compactValue(record(data.booking).trip_name) ||
    "Зураг"
  );
}

function extractedRows(doc: CustomerDocument) {
  const data = doc.extracted_json || {};
  const category = documentCategory(doc.category);
  const rows: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown) => {
    const text = compactValue(value);
    if (text) rows.push({ label, value: text });
  };
  // Skip the field already promoted to the card title (amount / name).
  if (category !== "payment_screenshot") add("Товч", data.summary);
  const passport = record(data.passport);
  if (category !== "passport") add("Нэр", passport.full_name);
  add("Паспорт", passport.passport_number);
  add("Төрсөн огноо", passport.date_of_birth);
  add("Дуусах огноо", passport.expiry_date);
  const trip = record(data.trip);
  add("Аялал", trip.title);
  add("Чиглэл", trip.destination);
  add("Огноо", trip.departure_dates);
  add("Үнэ", trip.price_text);
  const payment = record(data.payment);
  if (category === "payment_screenshot") add("Товч", data.summary);
  else add("Дүн", formatAmount(payment.amount, payment.currency));
  add("Илгээгч", payment.sender_name);
  add("Утас (гүйлгээ)", payment.phone);
  add("Гүйлгээний утга", payment.description);
  add("Журнал №", payment.reference);
  add("Төлсөн огноо", payment.date);
  const booking = record(data.booking);
  add("Код", booking.code);
  add("Аяллын нэр", booking.trip_name);
  add("Зорчигч", booking.traveler_name);
  add("Утас", booking.phone);
  add("Тэмдэглэл", booking.notes);
  add("Уншигдсан текст", data.visible_text);
  return rows.slice(0, 10);
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
    documentTitle(doc),
    tripMatchName(doc),
    ...rows,
  ].map(compactValue).filter(Boolean).join(" ").toLowerCase();
}

const PAYMENT_STATUS_LABELS = {
  pending: "Хүлээгдэж байна",
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

function senderTitle(input: { display_name: string; sender_id: string }) {
  return input.display_name || `Хэрэглэгч …${shortId(input.sender_id)}`;
}

type EditFields = {
  summary: string;
  visibleText: string;
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
  passportNationality: string;
  passportSex: string;
  bookingCode: string;
  bookingTripName: string;
  bookingTravelerName: string;
  bookingPhone: string;
  bookingNotes: string;
  tripTitle: string;
  tripDestination: string;
  tripDepartureDates: string;
  tripPriceText: string;
  tripDuration: string;
  tripOperator: string;
};

function editFieldsFromDocument(doc: CustomerDocument): EditFields {
  const data = doc.extracted_json || {};
  const payment = record(data.payment);
  const passport = record(data.passport);
  const booking = record(data.booking);
  const trip = record(data.trip);
  return {
    summary: compactValue(data.summary),
    visibleText: compactValue(data.visible_text),
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
    passportNationality: compactValue(passport.nationality),
    passportSex: compactValue(passport.sex),
    bookingCode: compactValue(booking.code),
    bookingTripName: compactValue(booking.trip_name),
    bookingTravelerName: compactValue(booking.traveler_name),
    bookingPhone: compactValue(booking.phone),
    bookingNotes: compactValue(booking.notes),
    tripTitle: compactValue(trip.title),
    tripDestination: compactValue(trip.destination),
    tripDepartureDates: compactValue(trip.departure_dates),
    tripPriceText: compactValue(trip.price_text),
    tripDuration: compactValue(trip.duration),
    tripOperator: compactValue(trip.operator),
  };
}

function buildEditedJson(doc: CustomerDocument, fields: EditFields): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(doc.extracted_json || {}) };
  next.summary = fields.summary;
  const category = documentCategory(doc.category);
  if (category === "payment_screenshot") {
    next.payment = {
      ...record(next.payment),
      amount: fields.paymentAmount,
      currency: fields.paymentCurrency,
      sender_name: fields.paymentSender,
      phone: fields.paymentPhone,
      description: fields.paymentDescription,
      reference: fields.paymentReference,
      date: fields.paymentDate,
    };
  }
  if (category === "passport") {
    next.passport = {
      ...record(next.passport),
      full_name: fields.passportName,
      passport_number: fields.passportNumber,
      date_of_birth: fields.passportBirthDate,
      expiry_date: fields.passportExpiryDate,
      nationality: fields.passportNationality,
      sex: fields.passportSex,
    };
  }
  if (category === "booking_code") {
    next.booking = {
      ...record(next.booking),
      code: fields.bookingCode,
      trip_name: fields.bookingTripName,
      traveler_name: fields.bookingTravelerName,
      phone: fields.bookingPhone,
      notes: fields.bookingNotes,
    };
  }
  if (category === "trip_screenshot") {
    next.trip = {
      ...record(next.trip),
      title: fields.tripTitle,
      destination: fields.tripDestination,
      departure_dates: fields.tripDepartureDates
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      price_text: fields.tripPriceText,
      duration: fields.tripDuration,
      operator: fields.tripOperator,
    };
  }
  if (category === "travel_document" || category === "other") {
    next.visible_text = fields.visibleText;
  }
  return next;
}

const VISIBLE_DETAIL_ROWS = 4;

function isImageDocument(doc: CustomerDocument): boolean {
  return /^image\//i.test(doc.mime_type || "");
}

function documentFileName(doc: CustomerDocument): string {
  const file = record(doc.extracted_json?.file);
  return compactValue(file.name) || compactValue(doc.source_url.split("/").pop()) || "attachment";
}

function DocumentCard({
  doc,
  busyId,
  onEdit,
  onDelete,
  onRestore,
  onOpenPerson,
  senderLabel,
  showSender,
  showDeleted,
}: {
  doc: CustomerDocument;
  busyId: number | null;
  onEdit: (doc: CustomerDocument) => void;
  onDelete: (doc: CustomerDocument) => void;
  onRestore: (doc: CustomerDocument) => void;
  onOpenPerson?: (senderId: string) => void;
  senderLabel?: string;
  showSender: boolean;
  showDeleted: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = extractedRows(doc);
  const visibleRows = expanded ? rows : rows.slice(0, VISIBLE_DETAIL_ROWS);
  const hiddenRowCount = rows.length - visibleRows.length;
  const imageUrl = doc.stored_url || doc.source_url;
  const matchedTrip = tripMatchName(doc);
  const category = documentCategory(doc.category);
  const busy = busyId === doc.id;
  const imageLike = isImageDocument(doc);
  return (
    <Card className="overflow-hidden p-0">
      <div className="grid gap-0 sm:grid-cols-[168px_1fr]">
        <a
          href={imageUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={imageLike ? "Зургийг бүтнээр нээх" : "Файлыг нээх"}
          className="group relative flex min-h-52 items-center justify-center bg-surface-sunken"
        >
          {imageLike ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt=""
              className="h-52 w-full object-contain p-1.5 transition-opacity group-hover:opacity-90 sm:h-full sm:max-h-72"
              loading="lazy"
            />
          ) : (
            <div className="flex w-full flex-col items-center gap-2 px-3 py-6 text-center">
              <Icons.file size={30} className="text-brand" />
              <span className="max-w-full truncate text-xs font-semibold text-ink">
                {documentFileName(doc)}
              </span>
              <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-ink-muted">
                {doc.mime_type || "file"}
              </span>
            </div>
          )}
        </a>
        <div className="flex min-w-0 flex-col p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-[15px] font-bold leading-6 text-ink" title={documentTitle(doc)}>
                {category === "payment_screenshot" ? (
                  <span className="font-mono tracking-tight">{documentTitle(doc)}</span>
                ) : (
                  documentTitle(doc)
                )}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-ink-subtle">
                <span>
                  {DOCUMENT_CATEGORY_ICONS[category]} {DOCUMENT_CATEGORY_LABELS[category]}
                </span>
                <span aria-hidden="true">·</span>
                <span>{formatTime(doc.created_at)}</span>
                {doc.retention_hidden_at && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Архивласан</span>
                  </>
                )}
                {doc.matched_payment_id && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Төлбөр #{doc.matched_payment_id}</span>
                  </>
                )}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {busy ? (
                <Spinner className="mx-1.5 h-4 w-4 text-brand" />
              ) : showDeleted ? (
                <Button size="sm" variant="success" onClick={() => onRestore(doc)}>
                  <Icons.refresh size={14} />
                  Сэргээх
                </Button>
              ) : (
                <>
                  <IconButton label="Засах" onClick={() => onEdit(doc)}>
                    <Icons.edit size={15} />
                  </IconButton>
                  <IconButton
                    label="Устгах (сэргээх боломжтой)"
                    onClick={() => onDelete(doc)}
                    className="hover:bg-danger-soft hover:text-danger"
                  >
                    <Icons.trash size={15} />
                  </IconButton>
                </>
              )}
            </div>
          </div>

          {(doc.matched_payment_status || matchedTrip) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {doc.matched_payment_status && (
                <Badge tone={PAYMENT_STATUS_TONE[doc.matched_payment_status]}>
                  {PAYMENT_STATUS_LABELS[doc.matched_payment_status]}
                  {typeof doc.matched_payment_amount === "number"
                    ? ` · ${doc.matched_payment_amount.toLocaleString("en-US")}₮`
                    : ""}
                </Badge>
              )}
              {matchedTrip && <Badge tone="success">✈️ {matchedTrip}</Badge>}
            </div>
          )}

          <div className="mt-2.5 flex-1 space-y-1">
            {rows.length === 0 ? (
              <p className="rounded-md bg-surface-sunken px-2.5 py-2 text-xs text-ink-muted">
                Уншигдсан талбар алга — «Засах» дээр дараад гараар нөхөж болно.
              </p>
            ) : (
              <>
                {visibleRows.map((row) => (
                  <div key={row.label} className="grid grid-cols-[108px_1fr] gap-2 text-xs leading-5">
                    <span className="text-ink-subtle">{row.label}</span>
                    <span className="min-w-0 wrap-break-word font-medium text-ink">{row.value}</span>
                  </div>
                ))}
                {hiddenRowCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="rounded text-xs font-medium text-brand hover:text-brand-hover"
                  >
                    Дэлгэрэнгүй · {hiddenRowCount}
                  </button>
                )}
                {expanded && rows.length > VISIBLE_DETAIL_ROWS && (
                  <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    className="rounded text-xs font-medium text-ink-subtle hover:text-ink-muted"
                  >
                    Хураах
                  </button>
                )}
              </>
            )}
          </div>

          {showSender && (
            <button
              type="button"
              onClick={() => onOpenPerson?.(doc.sender_id)}
              className="mt-2.5 self-start rounded text-xs font-medium text-brand hover:text-brand-hover"
            >
              {senderLabel || `Хэрэглэгч …${shortId(doc.sender_id)}`} — бүх зураг →
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

/** yyyy-mm-dd in local time, for <input type="date"> values. */
function localIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const DATE_PRESETS: Array<{ label: string; days: number | null }> = [
  { label: "Өнөөдөр", days: 1 },
  { label: "7 хоног", days: 7 },
  { label: "30 хоног", days: 30 },
  { label: "Бүгд", days: null },
];

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
  const [category, setCategory] = useState<CustomerDocumentCategory | "all">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showDeleted, setShowDeleted] = useState(false);
  const [editing, setEditing] = useState<CustomerDocument | null>(null);
  const [editFields, setEditFields] = useState<EditFields>(() => editFieldsFromDocument({ extracted_json: {} } as CustomerDocument));

  const loadSenders = useCallback(async (options?: { quiet?: boolean }) => {
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
      if (!options?.quiet) toast.error("Хэрэглэгчдийн жагсаалтыг ачаалж чадсангүй.");
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
      // Name lookup for "all photos" cards — a person's name beats "…1450".
      // Quiet: a failed lookup only means IDs show, not an error worth a toast.
      if (view === "all") void loadSenders({ quiet: true });
    }
  }, [view, selectedSender, loadSenders, loadDocuments]);

  const senderNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const sender of senders) {
      if (sender.display_name) map.set(sender.sender_id, sender.display_name);
    }
    return map;
  }, [senders]);

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
        if (category !== "all" && documentCategory(doc.category) !== category) return false;
        if (!query) return true;
        return documentSearchText(doc).includes(query);
      });
    },
    [category, documents, search],
  );

  const documentsByCategory = useMemo(() => {
    const groups = new Map<CustomerDocumentCategory, CustomerDocument[]>();
    for (const doc of visibleDocuments) {
      const docCategory = documentCategory(doc.category);
      const list = groups.get(docCategory) || [];
      list.push(doc);
      groups.set(docCategory, list);
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
      toast.success("Устгагдлаа. «Устгасан» хэсгээс сэргээж болно.");
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

  function applyDatePreset(days: number | null) {
    if (days == null) {
      setDateFrom("");
      setDateTo("");
      return;
    }
    const today = new Date();
    const from = new Date(today);
    from.setDate(today.getDate() - (days - 1));
    setDateFrom(localIsoDate(from));
    setDateTo(localIsoDate(today));
  }

  function presetActive(days: number | null): boolean {
    if (days == null) return !dateFrom && !dateTo;
    const today = new Date();
    const from = new Date(today);
    from.setDate(today.getDate() - (days - 1));
    return dateFrom === localIsoDate(from) && dateTo === localIsoDate(today);
  }

  const showPeopleList = view === "people" && !selectedSender;
  const showPersonDetail = view === "people" && Boolean(selectedSender);
  const editingCategory = editing ? documentCategory(editing.category) : "other";
  const anyLoading = sendersLoading || loading;
  const resultCount = showPeopleList ? filteredSenders.length : visibleDocuments.length;
  const resultNoun = showPeopleList ? "хэрэглэгч" : "зураг";

  return (
    <div className="space-y-3">
      <TabHeader
        icon={<Icons.file size={20} />}
        title="Ирсэн зургууд"
        description="Хэрэглэгчээс ирсэн бүх зураг автоматаар хадгалагдана. Устгасныг дараа нь сэргээж болно."
      />
      <Card className="space-y-2.5 p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-line-strong bg-surface-sunken p-0.5">
            <button
              type="button"
              onClick={() => {
                setSelectedSender(null);
                setView("people");
              }}
              className={cx(
                "rounded-[6px] px-3 py-1.5 text-xs font-medium transition-colors",
                view === "people" ? "bg-surface text-ink shadow-xs" : "text-ink-muted hover:text-ink",
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
                "rounded-[6px] px-3 py-1.5 text-xs font-medium transition-colors",
                view === "all" ? "bg-surface text-ink shadow-xs" : "text-ink-muted hover:text-ink",
              )}
            >
              Бүх зураг
            </button>
          </div>
          {view === "all" && (
            <Select
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as CustomerDocumentCategory | "all")
              }
              className="w-48"
            >
              <option value="all">Бүх төрөл</option>
              {DOCUMENT_CATEGORY_ORDER.map((key) => (
                <option key={key} value={key}>
                  {DOCUMENT_CATEGORY_ICONS[key]} {DOCUMENT_CATEGORY_LABELS[key]}
                </option>
              ))}
            </Select>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowDeleted((value) => !value)}
              aria-pressed={showDeleted}
              className={cx(
                "h-9 rounded-full px-3 text-xs font-medium transition-colors",
                showDeleted
                  ? "bg-danger-soft text-danger ring-1 ring-danger/30"
                  : "bg-surface-sunken text-ink-muted hover:text-ink",
              )}
            >
              🗑 Устгасан
            </button>
            <IconButton
              label="Шинэчлэх"
              onClick={() => (showPeopleList ? void loadSenders() : void loadDocuments())}
            >
              {anyLoading ? <Spinner className="h-4 w-4" /> : <Icons.refresh size={17} />}
            </IconButton>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5">
            {DATE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => applyDatePreset(preset.days)}
                className={cx(
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  presetActive(preset.days)
                    ? "bg-brand text-white"
                    : "bg-surface-sunken text-ink-muted hover:bg-brand-soft hover:text-brand",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-ink-subtle">
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-9 w-34 text-xs"
              aria-label="Эхлэх өдөр"
            />
            <span aria-hidden="true">—</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-9 w-34 text-xs"
              aria-label="Дуусах өдөр"
            />
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <Input
            placeholder={
              showPeopleList
                ? "Нэр, ID-аар хайх…"
                : "Нэр, утас, дүн, журнал №, паспорт, аялал…"
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
          {!anyLoading && (
            <span className="shrink-0 text-xs text-ink-subtle">
              {resultCount} {resultNoun}
            </span>
          )}
        </div>
      </Card>

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
                  className="rounded-xl text-left"
                >
                  <Card className="h-full p-3.5 transition-colors hover:border-brand">
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
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {DOCUMENT_CATEGORY_ORDER.map((key) => {
                        const count = sender.by_category[key] || 0;
                        return count ? (
                          <span
                            key={key}
                            className="rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-ink-muted"
                            title={DOCUMENT_CATEGORY_LABELS[key]}
                          >
                            {DOCUMENT_CATEGORY_ICONS[key]} {DOCUMENT_CATEGORY_SHORT_LABELS[key]} {count}
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
            <IconButton label="Буцах" onClick={() => setSelectedSender(null)}>
              <Icons.chevronLeft size={17} />
            </IconButton>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand">
              {(selectedSenderSummary?.display_name || "?").slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">
                {selectedSenderSummary
                  ? senderTitle(selectedSenderSummary)
                  : `Хэрэглэгч …${shortId(selectedSender || "")}`}
              </p>
              {selectedSenderSummary && (
                <p className="text-[11px] text-ink-subtle">
                  {selectedSenderSummary.total} зураг · сүүлд {formatTime(selectedSenderSummary.last_at)}
                </p>
              )}
            </div>
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
            DOCUMENT_CATEGORY_ORDER.map((key) => {
              const docs = documentsByCategory.get(key);
              if (!docs || docs.length === 0) return null;
              return (
                <div key={key} className="space-y-2">
                  <p className="text-sm font-semibold text-ink">
                    {DOCUMENT_CATEGORY_ICONS[key]} {DOCUMENT_CATEGORY_LABELS[key]}{" "}
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
                  senderLabel={senderNameById.get(doc.sender_id)}
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
              <span>{DOCUMENT_CATEGORY_ICONS[editingCategory]}</span>
              <span>{DOCUMENT_CATEGORY_LABELS[editingCategory]}</span>
              <span className="text-ink-subtle">#{editing.id}</span>
            </div>
          )}
          <Input
            label="Товч"
            value={editFields.summary}
            onChange={(e) => setEditField("summary", e.target.value)}
          />
          {editingCategory === "payment_screenshot" && (
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
          {editingCategory === "passport" && (
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
              <Input
                label="Иргэншил"
                value={editFields.passportNationality}
                onChange={(e) => setEditField("passportNationality", e.target.value)}
              />
              <Input
                label="Хүйс"
                value={editFields.passportSex}
                onChange={(e) => setEditField("passportSex", e.target.value)}
              />
            </div>
          )}
          {editingCategory === "booking_code" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Код"
                value={editFields.bookingCode}
                onChange={(e) => setEditField("bookingCode", e.target.value)}
              />
              <Input
                label="Аяллын нэр"
                value={editFields.bookingTripName}
                onChange={(e) => setEditField("bookingTripName", e.target.value)}
              />
              <Input
                label="Зорчигч"
                value={editFields.bookingTravelerName}
                onChange={(e) => setEditField("bookingTravelerName", e.target.value)}
              />
              <Input
                label="Утас"
                value={editFields.bookingPhone}
                onChange={(e) => setEditField("bookingPhone", e.target.value)}
              />
              <div className="sm:col-span-2">
                <Textarea
                  label="Тэмдэглэл"
                  rows={3}
                  value={editFields.bookingNotes}
                  onChange={(e) => setEditField("bookingNotes", e.target.value)}
                />
              </div>
            </div>
          )}
          {editingCategory === "trip_screenshot" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Аяллын нэр"
                value={editFields.tripTitle}
                onChange={(e) => setEditField("tripTitle", e.target.value)}
              />
              <Input
                label="Чиглэл"
                value={editFields.tripDestination}
                onChange={(e) => setEditField("tripDestination", e.target.value)}
              />
              <Input
                label="Гарах өдрүүд"
                value={editFields.tripDepartureDates}
                onChange={(e) => setEditField("tripDepartureDates", e.target.value)}
              />
              <Input
                label="Үнэ"
                value={editFields.tripPriceText}
                onChange={(e) => setEditField("tripPriceText", e.target.value)}
              />
              <Input
                label="Хугацаа"
                value={editFields.tripDuration}
                onChange={(e) => setEditField("tripDuration", e.target.value)}
              />
              <Input
                label="Оператор"
                value={editFields.tripOperator}
                onChange={(e) => setEditField("tripOperator", e.target.value)}
              />
            </div>
          )}
          {(editingCategory === "travel_document" || editingCategory === "other") && (
            <Textarea
              label="Уншигдсан текст"
              rows={5}
              value={editFields.visibleText}
              onChange={(e) => setEditField("visibleText", e.target.value)}
            />
          )}
        </div>
      </Modal>
    </div>
  );
}
