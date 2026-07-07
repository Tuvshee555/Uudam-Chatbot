import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icons,
  Modal,
  Select,
  Spinner,
  Textarea,
  cx,
  useToast,
} from "@/components/ui";
import type {
  CustomerDocument,
  CustomerDocumentCategory,
  CustomerDocumentStatus,
} from "@/lib/adminTypes";
import { formatTime, shortId } from "@/lib/adminUtils";

const CATEGORY_LABELS: Record<CustomerDocumentCategory, string> = {
  passport: "Паспорт",
  travel_document: "Бичиг баримт",
  booking_code: "Код",
  trip_screenshot: "Аяллын screenshot",
  payment_screenshot: "Төлбөрийн screenshot",
  other: "Бусад",
};

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

function extractedRows(doc: CustomerDocument) {
  const data = doc.extracted_json || {};
  const rows: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown) => {
    const text = compactValue(value);
    if (text) rows.push({ label, value: text });
  };
  add("Товч", data.summary);
  add("Илэрсэн текст", data.visible_text);
  const passport = data.passport && typeof data.passport === "object"
    ? (data.passport as Record<string, unknown>)
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
  add("Хугацаа", trip.duration);
  const payment = data.payment && typeof data.payment === "object"
    ? (data.payment as Record<string, unknown>)
    : {};
  add("Дүн", payment.amount);
  add("Валют", payment.currency);
  add("Гүйлгээ", payment.reference);
  add("Төлсөн огноо", payment.date);
  const booking = data.booking && typeof data.booking === "object"
    ? (data.booking as Record<string, unknown>)
    : {};
  add("Код", booking.code);
  add("Аяллын нэр", booking.trip_name);
  add("Зорчигч", booking.traveler_name);
  add("Утас", booking.phone);
  add("Тэмдэглэл", booking.notes);
  return rows.slice(0, 10);
}

function confidenceLabel(value: number) {
  const score = Number.isFinite(value) ? value : 0;
  if (score >= 0.82) return { label: "High", tone: "success" as const };
  if (score >= 0.55) return { label: "Medium", tone: "warning" as const };
  return { label: "Low", tone: "danger" as const };
}

export function CustomerDocumentsTab({
  apiFetch,
  onChanged,
}: {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [documents, setDocuments] = useState<CustomerDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [status, setStatus] = useState<CustomerDocumentStatus | "all">("needs_review");
  const [category, setCategory] = useState<CustomerDocumentCategory | "all">("all");
  const [editing, setEditing] = useState<CustomerDocument | null>(null);
  const [editJson, setEditJson] = useState("");
  const [editStatus, setEditStatus] = useState<CustomerDocumentStatus>("needs_review");

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status,
        category,
        limit: "120",
      });
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
  }, [apiFetch, category, status, toast]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const doc of documents) {
      result[doc.category] = (result[doc.category] || 0) + 1;
    }
    return result;
  }, [documents]);

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
        status === "all"
          ? prev.map((item) => (item.id === doc.id ? { ...item, status: nextStatus } : item))
          : prev.filter((item) => item.id !== doc.id),
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
        prev.map((item) => (item.id === editing.id ? json.document as CustomerDocument : item)),
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

  return (
    <div className="space-y-3">
      <Card className="p-3.5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="font-semibold text-ink">Зургаар ирсэн мэдээлэл</p>
            <p className="text-xs text-ink-subtle">
              Messenger-ээр ирсэн паспорт, бичиг баримт, аяллын screenshot-ууд.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as CustomerDocumentStatus | "all")}
              className="w-32"
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
              onChange={(e) => setCategory(e.target.value as CustomerDocumentCategory | "all")}
              className="w-44"
            >
              <option value="all">Бүх төрөл</option>
              {(Object.entries(CATEGORY_LABELS) as [CustomerDocumentCategory, string][]).map(
                ([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ),
              )}
            </Select>
            <button
              type="button"
              onClick={() => void loadDocuments()}
              aria-label="Шинэчлэх"
              className="flex h-10 w-10 items-center justify-center rounded-md border border-line-strong text-ink-muted hover:border-brand hover:text-brand"
            >
              {loading ? <Spinner /> : <Icons.refresh size={17} />}
            </button>
          </div>
        </div>
      </Card>

      {Object.keys(counts).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(Object.entries(CATEGORY_LABELS) as [CustomerDocumentCategory, string][]).map(
            ([key, label]) =>
              counts[key] ? (
                <Badge key={key} tone="neutral">
                  {label}: {counts[key]}
                </Badge>
              ) : null,
          )}
        </div>
      )}

      {!loading && documents.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            icon={<Icons.image size={26} />}
            title="Зурагтай бичлэг алга"
            description="Шинэ паспорт, бичиг баримт эсвэл аяллын screenshot ирвэл энд харагдана."
          />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {documents.map((doc) => {
            const rows = extractedRows(doc);
            const imageUrl = doc.stored_url || doc.source_url;
            return (
              <Card key={doc.id} className="overflow-hidden p-0">
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
                      <Badge tone={STATUS_TONE[doc.status]}>
                        {STATUS_LABELS[doc.status]}
                      </Badge>
                      <Badge tone="neutral">
                        {CATEGORY_LABELS[doc.category]}
                      </Badge>
                      <Badge tone={confidenceLabel(doc.confidence).tone}>
                        AI {confidenceLabel(doc.confidence).label}
                      </Badge>
                      {doc.duplicate_of_id && (
                        <Badge tone="neutral">Duplicate #{doc.duplicate_of_id}</Badge>
                      )}
                      {doc.matched_payment_id && (
                        <Badge tone="success">Payment #{doc.matched_payment_id}</Badge>
                      )}
                      <span className="text-xs text-ink-subtle">
                        {formatTime(doc.created_at)}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-ink-subtle">
                      Customer ID:{" "}
                      <span className="font-mono">{shortId(doc.sender_id)}</span>
                    </p>
                    <div className="mt-3 space-y-1.5">
                      {rows.length === 0 ? (
                        <p className="rounded-md border border-line bg-surface-sunken px-2.5 py-2 text-xs text-ink-subtle">
                          Уншигдсан талбар алга. Гараар шалгана уу.
                        </p>
                      ) : (
                        rows.map((row) => (
                          <div key={row.label} className="grid grid-cols-[92px_1fr] gap-2 text-xs">
                            <span className="text-ink-subtle">{row.label}</span>
                            <span className="min-w-0 break-words font-medium text-ink">
                              {row.value}
                            </span>
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
                        onClick={() => void updateStatus(doc, "verified")}
                      >
                        <Icons.check size={14} />
                        Баталгаажсан
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyId === doc.id}
                        onClick={() => openEdit(doc)}
                      >
                        <Icons.edit size={14} />
                        Засах
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyId === doc.id || doc.status === "wrong_extraction"}
                        onClick={() => void updateStatus(doc, "wrong_extraction")}
                      >
                        Буруу
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyId === doc.id || doc.status === "ignored"}
                        onClick={() => void updateStatus(doc, "ignored")}
                      >
                        Алгасах
                      </Button>
                    </div>
                    {doc.category === "passport" && (
                      <p className="mt-2 text-[11px] text-danger">
                        Паспортын мэдээллийг хадгалахаас өмнө заавал зурагтай нь тулгаж шалгана уу.
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {loading && documents.length === 0 && (
        <div className="flex justify-center py-8">
          <Spinner className="h-6 w-6 text-brand" />
        </div>
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
