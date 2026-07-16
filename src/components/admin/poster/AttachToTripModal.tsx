import React from "react";
import { Alert, Badge, Button, Icons, Modal, Select, Spinner, cx } from "@/components/ui";
import type { ApiFetch, CapturedPosterImage, PosterTrip } from "./PosterTab";

/* ------------------------------------------------------------------ *
 * These field keys mirror MappedTripFields in src/lib/poster/tripMapper.ts
 * (server-side mapping of poster data onto real trip fields) plus the
 * "extra" sub-keys it nests (included_items/excluded_items), which this
 * modal flattens into top-level diff rows for display.
 * ------------------------------------------------------------------ */
type FieldKey =
  | "route_name"
  | "duration_text"
  | "departure_dates"
  | "adult_price"
  | "child_price"
  | "hotel"
  | "has_food"
  | "included_items"
  | "excluded_items";

const FIELD_LABELS: Record<string, string> = {
  route_name: "Аяллын нэр",
  duration_text: "Хугацаа",
  departure_dates: "Гарах өдрүүд",
  adult_price: "Том хүний үнэ",
  child_price: "Хүүхдийн үнэ",
  hotel: "Зочид буудал",
  has_food: "Хоол багтсан эсэх",
  included_items: "Багтсан зүйлс",
  excluded_items: "Багтаагүй зүйлс",
};

/** A field value as seen in this modal: either the poster's mapped value or a
 * matched trip's current value. Shapes mirror MappedTripFields/TripMutationFields. */
type FieldValue = string | number | boolean | string[] | null | undefined;

function formatFieldValue(key: string, value: FieldValue): string {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (key === "has_food") return value ? "Тийм" : "Үгүй";
  if ((key === "adult_price" || key === "child_price") && typeof value === "number") {
    return `${value.toLocaleString()}₮`;
  }
  return String(value);
}

// Cosmetic normalization: posters write titles in ALL CAPS with en-dashes and
// "8 өдөр / 7 шөнө" style separators. "БЭЭЖИН – ЖИНИН" vs "Бээжин - Жинин" is
// NOT a real difference — proposing it as a pre-checked change would downgrade
// a nicely-cased trip name to shouting caps on one click.
function cosmetic(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\s\-–—−/\\.,:;·]+/g, " ")
    .trim();
}

function valuesEqual(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const arrA = Array.isArray(a) ? a : [];
    const arrB = Array.isArray(b) ? b : [];
    return arrA.length === arrB.length && arrA.every((v, i) => cosmetic(v) === cosmetic(arrB[i]));
  }
  if (typeof a === "string" || typeof b === "string") {
    return cosmetic(a) === cosmetic(b);
  }
  return (a ?? null) === (b ?? null);
}

/** A candidate trip returned by /api/admin/poster-match, mirroring the
 * `toCandidate` shape built server-side in src/pages/api/admin/poster-match.ts. */
type MatchCandidate = {
  id: string;
  route_name: string;
  operator_name?: string | null;
  category?: string | null;
  photoCount: number;
  currentFields: Partial<Record<FieldKey, FieldValue>>;
};

/** The poster-data-mapped-onto-trip-fields payload from poster-match, mirroring
 * MappedTripFields in tripMapper.ts (its "extra" sub-object is flattened by diffRows). */
type MappedFields = Partial<Record<FieldKey, FieldValue>> & {
  extra?: Partial<Record<FieldKey, FieldValue>>;
};

type DiffRow = {
  key: string;
  oldValue: FieldValue;
  newValue: FieldValue;
};

type SyncResult = {
  ok?: boolean;
  created?: boolean;
  tripId?: string;
  tripName?: string;
  mode?: "replace" | "append" | "skip";
  uploaded?: number;
  totalPhotos?: number;
  failed?: number;
  fieldsWritten?: string[];
  error?: string;
};

export type AttachToTripModalProps = {
  open: boolean;
  onClose: () => void;
  posterTitle: string;
  posterTrip: PosterTrip | null;
  apiFetch: ApiFetch;
  captureImages: () => Promise<CapturedPosterImage[]>;
  onDone?: (result: SyncResult) => void;
};

/**
 * Confirmation modal that attaches a poster to a real chatbot trip — both
 * its rendered images AND the AI-extracted data (price, dates, hotel, meals,
 * includes/excludes). Nothing is written until the user presses "Нэмэх":
 *
 *   1. On open, asks /api/admin/poster-match (read-only) which trips could
 *      match the poster's title. Returns each candidate's CURRENT field
 *      values plus the poster's data mapped onto trip fields.
 *   2. User picks the matched trip, overrides with a different one, or
 *      creates a brand-new trip from the poster title.
 *   3. Every field where poster data differs from the trip's current value
 *      is shown old-vs-new with its own checkbox — nothing is assumed.
 *   4. If the target trip already has photos, user picks replace vs append.
 *   5. Only on confirm: captures the poster as images and calls
 *      /api/admin/poster-sync with an EXPLICIT target + only the checked
 *      fields (never a guess, never a silent overwrite).
 *
 * Props:
 *   open           boolean
 *   onClose        () => void
 *   posterTitle    string
 *   posterTrip     object  (the full extracted poster JSON, for field mapping)
 *   apiFetch       (url, init) => Promise<Response>  (injects admin secret)
 *   captureImages  () => Promise<CapturedPosterImage[]>  (renders/uploads poster images)
 *   onDone         (result) => void  (called after a successful attach)
 */
export default function AttachToTripModal({
  open,
  onClose,
  posterTitle,
  posterTrip,
  apiFetch,
  captureImages,
  onDone,
}: AttachToTripModalProps) {
  const [loading, setLoading] = React.useState(false);
  const [matchError, setMatchError] = React.useState("");
  const [candidates, setCandidates] = React.useState<MatchCandidate[]>([]);
  const [allTrips, setAllTrips] = React.useState<MatchCandidate[]>([]);
  const [mappedFields, setMappedFields] = React.useState<MappedFields>({});
  const [target, setTarget] = React.useState(""); // tripId | "__new__" | ""
  const [mode, setMode] = React.useState<"replace" | "append" | "skip">("replace");
  const [approvedKeys, setApprovedKeys] = React.useState<Set<string>>(() => new Set());
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState("");
  const [result, setResult] = React.useState<SyncResult | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    setMatchError("");
    setSubmitError("");
    setResult(null);
    setCandidates([]);
    setAllTrips([]);
    setMappedFields({});
    setTarget("");
    setMode("replace");
    setApprovedKeys(new Set());

    (async () => {
      try {
        const res = await apiFetch("/api/admin/poster-match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tripTitle: posterTitle, posterTrip: posterTrip || null }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "Тохирох аялал хайхад алдаа гарлаа");
        setCandidates(json.candidates || []);
        setAllTrips(json.allTrips || []);
        setMappedFields(json.mappedFields || {});
        setTarget(json.candidates?.[0]?.id || "__new__");
      } catch (e) {
        setMatchError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, posterTitle, posterTrip, apiFetch]);

  const isNew = target === "__new__";
  const bestId = candidates[0]?.id;
  const selectedTrip = React.useMemo(() => {
    if (!target || isNew) return null;
    return candidates.find((c) => c.id === target) || allTrips.find((t) => t.id === target) || null;
  }, [target, isNew, candidates, allTrips]);

  React.useEffect(() => {
    if (isNew || !selectedTrip || selectedTrip.photoCount === 0) setMode("replace");
  }, [isNew, selectedTrip]);

  // Fields where the poster's data differs from the selected trip's current
  // value. For a new trip, every mapped field is "new" (nothing to diff against).
  const diffRows = React.useMemo<DiffRow[]>(() => {
    const current = selectedTrip?.currentFields || {};
    return Object.keys(mappedFields)
      .filter((key) => key !== "extra")
      .map((key) => ({ key, oldValue: current[key as FieldKey], newValue: mappedFields[key as FieldKey] }))
      .concat(
        mappedFields.extra
          ? Object.keys(mappedFields.extra).map((key) => ({
              key,
              oldValue: current[key as FieldKey],
              newValue: mappedFields.extra?.[key as FieldKey],
            }))
          : [],
      )
      .filter((row) => isNew || !valuesEqual(row.oldValue, row.newValue))
      .filter((row) => row.newValue != null && row.newValue !== "" && !(Array.isArray(row.newValue) && row.newValue.length === 0));
  }, [mappedFields, selectedTrip, isNew]);

  // Default: pre-check every differing field so the common case is one click.
  React.useEffect(() => {
    setApprovedKeys(new Set(diffRows.map((r) => r.key)));
  }, [diffRows]);

  function toggleField(key: string) {
    setApprovedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const hasApprovedFields = diffRows.some((row) => approvedKeys.has(row.key));
  const willWritePhotos = isNew || mode !== "skip";
  const canSubmit =
    !loading &&
    !submitting &&
    !result &&
    (isNew || Boolean(selectedTrip)) &&
    (willWritePhotos || hasApprovedFields);

  function buildApprovedFieldsPayload(): Record<string, unknown> {
    const EXTRA_KEYS = new Set(["included_items", "excluded_items"]);
    const fields: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    for (const row of diffRows) {
      if (!approvedKeys.has(row.key)) continue;
      if (EXTRA_KEYS.has(row.key)) extra[row.key] = row.newValue;
      else fields[row.key] = row.newValue;
    }
    if (Object.keys(extra).length) fields.extra = extra;
    return fields;
  }

  function buildPhotoPayload(image: CapturedPosterImage, index: number) {
    const fallbackFilename = `${(posterTitle || "poster").slice(0, 30).replace(/[^\p{L}\p{N}]+/gu, "-")}-${index + 1}.png`;
    if (typeof image === "string") {
      return image.startsWith("data:")
        ? { dataUrl: image, filename: fallbackFilename }
        : { url: image, filename: fallbackFilename };
    }
    const filename = image.filename || fallbackFilename;
    if (image.url) return { url: image.url, filename };
    return { dataUrl: image.dataUrl || "", filename };
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError("");
    try {
      const images = willWritePhotos ? await captureImages() : [];
      const photos = (images || []).map(buildPhotoPayload).filter((photo) => photo.dataUrl || photo.url);
      const fields = buildApprovedFieldsPayload();

      const res = await apiFetch("/api/admin/poster-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tripId: isNew ? undefined : target,
          createNew: isNew || undefined,
          newTripTitle: isNew ? posterTitle : undefined,
          mode,
          photos,
          fields,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Хадгалахад алдаа гарлаа");
      setResult(json);
      onDone?.(json);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Аялалд нэмэх"
      description={`«${posterTitle || "Untitled"}» постерыг аяллын мэдээлэлд холбоно`}
      footer={
        result ? (
          <Button onClick={onClose}>Болсон</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              Болих
            </Button>
            <Button loading={submitting} disabled={!canSubmit} onClick={handleSubmit}>
              <Icons.plus size={15} />
              Нэмэх
            </Button>
          </>
        )
      }
    >
      {result ? (
        <Alert tone="success">
          <div className="font-medium">
            {result.created ? "Шинэ аялал үүсгэв: " : "Аялалд нэмэгдлээ: "}
            <b>{result.tripName}</b>
          </div>
          <p className="mt-1 text-sm">
            {(result.uploaded ?? 0) > 0 && `Оруулсан зураг: ${result.uploaded} · Нийт зураг: ${result.totalPhotos}`}
            {(result.failed ?? 0) > 0 && ` · Амжилтгүй: ${result.failed}`}
          </p>
          {result.fieldsWritten && result.fieldsWritten.length > 0 && (
            <p className="mt-1 text-sm">
              Шинэчилсэн мэдээлэл: {result.fieldsWritten.map((k) => FIELD_LABELS[k] || k).join(", ")}
            </p>
          )}
        </Alert>
      ) : (
        <div className="space-y-4">
          {matchError && <Alert tone="danger">{matchError}</Alert>}
          {submitError && <Alert tone="danger">{submitError}</Alert>}

          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-ink-muted">
              <Spinner /> Тохирох аялал хайж байна…
            </div>
          ) : (
            <>
              {candidates.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-ink">Тохирох аялал олдлоо</p>
                  {candidates.map((c) => (
                    <label
                      key={c.id}
                      className={cx(
                        "flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm transition-colors",
                        target === c.id ? "border-brand bg-brand-soft" : "border-line hover:border-line-strong",
                      )}
                    >
                      <input
                        type="radio"
                        className="mt-1 accent-brand"
                        checked={target === c.id}
                        onChange={() => setTarget(c.id)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium text-ink">{c.route_name}</span>
                          {c.id === bestId && <Badge tone="brand">хамгийн тохирох</Badge>}
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-subtle">
                          {c.category || "Ангилалгүй"} · одоо {c.photoCount} зурагтай
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <Alert tone="warning">
                  «{posterTitle}» нэртэй тохирох аялал олдсонгүй. Доороос гараар сонгох эсвэл шинэ
                  аялал үүсгэнэ үү.
                </Alert>
              )}

              <div>
                <p className="mb-1 text-sm font-medium text-ink">Өөр аялал сонгох</p>
                <Select
                  value={isNew ? "" : target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">— Аялал сонгох —</option>
                  {allTrips.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.route_name} ({t.photoCount} зураг)
                    </option>
                  ))}
                </Select>
              </div>

              <label
                className={cx(
                  "flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-sm transition-colors",
                  isNew ? "border-brand bg-brand-soft" : "border-line hover:border-line-strong",
                )}
              >
                <input
                  type="radio"
                  className="accent-brand"
                  checked={isNew}
                  onChange={() => setTarget("__new__")}
                />
                <Icons.plus size={14} className="shrink-0 text-ink-muted" />
                <span>
                  Шинэ аялал болгож үүсгэх: <b>{posterTitle || "(нэргүй)"}</b>
                </span>
              </label>

              {!isNew && selectedTrip && selectedTrip.photoCount > 0 && (
                <div>
                  <p className="mb-1 text-sm text-ink-muted">
                    Энэ аялалд аль хэдийн <b>{selectedTrip.photoCount}</b> зураг байна:
                  </p>
                  <label className="flex items-center gap-2 py-1 text-sm">
                    <input
                      type="radio"
                      className="accent-brand"
                      checked={mode === "replace"}
                      onChange={() => setMode("replace")}
                    />
                    Хуучныг устгаад солих (зөвлөмж)
                  </label>
                  <label className="flex items-center gap-2 py-1 text-sm">
                    <input
                      type="radio"
                      className="accent-brand"
                      checked={mode === "append"}
                      onChange={() => setMode("append")}
                    />
                    Хуучин дээр нэмэх
                  </label>
                  <label className="flex items-center gap-2 py-1 text-sm">
                    <input
                      type="radio"
                      className="accent-brand"
                      checked={mode === "skip"}
                      onChange={() => setMode("skip")}
                    />
                    Зургийг өөрчлөхгүй
                  </label>
                </div>
              )}

              {(isNew || selectedTrip) && diffRows.length > 0 && (
                <div>
                  <p className="mb-1 text-sm font-medium text-ink">
                    {isNew ? "Постероос дараах мэдээлэл орно" : "Постерын мэдээлэл өөр байна — шинэчлэх зүйлээ сонго"}
                  </p>
                  <div className="space-y-1.5 rounded-lg border border-line p-2">
                    {diffRows.map((row) => (
                      <label key={row.key} className="flex items-start gap-2 rounded-md p-1.5 text-sm hover:bg-surface-sunken">
                        <input
                          type="checkbox"
                          className="mt-1 accent-brand"
                          checked={approvedKeys.has(row.key)}
                          onChange={() => toggleField(row.key)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium text-ink">{FIELD_LABELS[row.key] || row.key}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                            {!isNew && (
                              <>
                                <span className="text-ink-subtle line-through">
                                  {formatFieldValue(row.key, row.oldValue)}
                                </span>
                                <span className="text-ink-subtle">→</span>
                              </>
                            )}
                            <span className="font-medium text-brand">
                              {formatFieldValue(row.key, row.newValue)}
                            </span>
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
