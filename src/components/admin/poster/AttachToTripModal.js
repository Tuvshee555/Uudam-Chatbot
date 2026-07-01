import React from "react";
import { Alert, Badge, Button, Icons, Modal, Select, Spinner, cx } from "@/components/ui";

/**
 * Confirmation modal that attaches the currently-rendered poster to a real
 * chatbot trip. Nothing is written until the user presses "Нэмэх":
 *   1. On open, asks /api/admin/poster-match (read-only) which trips could
 *      match the poster's title, with their current photo counts.
 *   2. User picks the matched trip, overrides with a different one, or
 *      creates a brand-new trip from the poster title.
 *   3. If the target trip already has photos, user picks replace vs append.
 *   4. Only on confirm: captures the poster as images and calls
 *      /api/admin/poster-sync with an EXPLICIT target (never a guess).
 *
 * Props:
 *   open           boolean
 *   onClose        () => void
 *   posterTitle    string
 *   apiFetch       (url, init) => Promise<Response>  (injects admin secret)
 *   captureImages  () => Promise<string[]>  (renders the poster to data-URL images)
 *   onDone         (result) => void  (called after a successful attach)
 */
export default function AttachToTripModal({
  open,
  onClose,
  posterTitle,
  apiFetch,
  captureImages,
  onDone,
}) {
  const [loading, setLoading] = React.useState(false);
  const [matchError, setMatchError] = React.useState("");
  const [candidates, setCandidates] = React.useState([]);
  const [allTrips, setAllTrips] = React.useState([]);
  const [target, setTarget] = React.useState(""); // tripId | "__new__" | ""
  const [mode, setMode] = React.useState("replace");
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState("");
  const [result, setResult] = React.useState(null);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    setMatchError("");
    setSubmitError("");
    setResult(null);
    setCandidates([]);
    setAllTrips([]);
    setTarget("");
    setMode("replace");

    (async () => {
      try {
        const res = await apiFetch("/api/admin/poster-match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tripTitle: posterTitle }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "Тохирох аялал хайхад алдаа гарлаа");
        setCandidates(json.candidates || []);
        setAllTrips(json.allTrips || []);
        setTarget(json.candidates?.[0]?.id || "");
      } catch (e) {
        setMatchError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, posterTitle, apiFetch]);

  const isNew = target === "__new__";
  const bestId = candidates[0]?.id;
  const selectedTrip = React.useMemo(() => {
    if (!target || isNew) return null;
    return candidates.find((c) => c.id === target) || allTrips.find((t) => t.id === target) || null;
  }, [target, isNew, candidates, allTrips]);

  const canSubmit = !loading && !submitting && !result && (isNew || Boolean(selectedTrip));

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError("");
    try {
      const images = await captureImages();
      if (!images || images.length === 0) throw new Error("Постерын зураг үүсгэж чадсангүй");

      const photos = images.map((dataUrl, i) => ({
        dataUrl,
        filename: `${(posterTitle || "poster").slice(0, 30).replace(/[^\p{L}\p{N}]+/gu, "-")}-${i + 1}.png`,
      }));

      const res = await apiFetch("/api/admin/poster-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tripId: isNew ? undefined : target,
          createNew: isNew || undefined,
          newTripTitle: isNew ? posterTitle : undefined,
          mode,
          photos,
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
      description={`«${posterTitle || "Untitled"}» постерыг аяллын зурагт хавсаргана`}
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
            Оруулсан зураг: {result.uploaded} · Нийт зураг: {result.totalPhotos}
            {result.failed > 0 && ` · Амжилтгүй: ${result.failed}`}
          </p>
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
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
