import React from "react";
import { Button, Card, Icons, Badge, Alert, cx, useToast } from "@/components/ui";
import type { TravelTrip } from "@/lib/adminTypes";
import type { MatchResult } from "@/lib/tripPhotoImport/types";

type PreviewItem = {
  id: string;
  name: string;
  sourceType: "zip" | "folder" | "image";
  imageCount: number;
  imageIds: string[];
  match: MatchResult;
  duplicateImageIds: string[];
  duplicateTripItemIds: string[];
  error?: string;
};

type ConfirmResult = {
  itemId: string;
  itemName: string;
  tripId: string | null;
  tripName: string;
  uploaded: number;
  failed: number;
  photoUrls: string[];
  error?: string;
};

export type TripPhotoImportTabProps = {
  trips: TravelTrip[];
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onComplete?: () => void;
};

const MAX_FILE_SIZE_MB = 10;

export function TripPhotoImportTab({ trips, apiFetch, onComplete }: TripPhotoImportTabProps) {
  const toast = useToast();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const folderInputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [batchId, setBatchId] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<PreviewItem[]>([]);
  const [overrides, setOverrides] = React.useState<Record<string, string | null>>({});
  const [skipped, setSkipped] = React.useState<Set<string>>(new Set());
  const [mode, setMode] = React.useState<"append" | "replace">("append");
  const [busy, setBusy] = React.useState(false);
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<ConfirmResult[] | null>(null);
  const [previewErrors, setPreviewErrors] = React.useState<string[]>([]);

  const sortedTrips = React.useMemo(
    () => [...trips].sort((a, b) => a.route_name.localeCompare(b.route_name)),
    [trips],
  );

  function reset() {
    setBatchId(null);
    setItems([]);
    setOverrides({});
    setSkipped(new Set());
    setResults(null);
    setPreviewErrors([]);
  }

  async function uploadFiles(fileList: FileList | File[] | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const oversized = files.filter((f) => f.size > MAX_FILE_SIZE_MB * 1024 * 1024);
    if (oversized.length > 0) {
      toast.error(`${oversized.length} файл 10MB-ээс том байна.`);
    }
    const valid = files.filter((f) => f.size <= MAX_FILE_SIZE_MB * 1024 * 1024);
    if (valid.length === 0) return;

    const formData = new FormData();
    for (const file of valid) {
      formData.append("files", file, file.name);
    }

    setBusy(true);
    try {
      const res = await apiFetch("/api/admin/trip-photos-preview", {
        method: "POST",
        body: formData,
      });
      const json = (await res.json()) as {
        batchId?: string;
        items?: PreviewItem[];
        errors?: string[];
        error?: string;
      };
      if (!res.ok || !json.batchId) {
        throw new Error(json.error || "Урьдчилан харахад алдаа гарлаа");
      }
      setBatchId(json.batchId);
      setItems(json.items || []);
      setPreviewErrors(json.errors || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Урьдчилан харахад алдаа гарлаа");
    } finally {
      setBusy(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    void uploadFiles(e.dataTransfer.files);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    void uploadFiles(e.target.files);
    e.target.value = "";
  }

  function handleFolderSelect(e: React.ChangeEvent<HTMLInputElement>) {
    void uploadFiles(e.target.files);
    e.target.value = "";
  }

  function setOverride(itemId: string, tripId: string | null) {
    setOverrides((prev) => ({ ...prev, [itemId]: tripId }));
  }

  function toggleSkip(itemId: string) {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  const hasUnassigned = items.some(
    (item) => !skipped.has(item.id) && !getEffectiveTripId(item),
  );

  function getEffectiveTripId(item: PreviewItem): string | null {
    const override = overrides[item.id];
    if (override === null) return null;
    return override ?? item.match.tripId ?? null;
  }

  async function confirmImport() {
    if (!batchId || items.length === 0) return;
    if (hasUnassigned) {
      toast.error("Тохирох аялал олдоогүй буюу сонгоогүй мөр байна. Алгасах эсвэл аялал сонгоно уу.");
      return;
    }

    const toConfirm = items.filter((item) => !skipped.has(item.id));
    if (toConfirm.length === 0) {
      toast.error("Баталгаажуулах мөр олдсонгүй.");
      return;
    }

    setResults([]);

    for (const item of toConfirm) {
      const effectiveTripId = getEffectiveTripId(item);
      const itemOverrides: Record<string, string | null> = {};
      if (effectiveTripId !== item.match.tripId) {
        itemOverrides[item.id] = effectiveTripId;
      }

      setConfirmingId(item.id);
      try {
        const res = await apiFetch("/api/admin/trip-photos-confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            batchId,
            mode,
            overrides: itemOverrides,
            skippedItemIds: Array.from(skipped),
            itemIds: [item.id],
          }),
        });
        const json = (await res.json()) as { results?: ConfirmResult[]; error?: string };
        if (!res.ok) {
          throw new Error(json.error || "Баталгаажуулахад алдаа гарлаа");
        }
        const itemResults = json.results || [];
        setResults((prev) => [...(prev || []), ...itemResults]);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Баталгаажуулахад алдаа гарлаа");
        setResults((prev) => [
          ...(prev || []),
          {
            itemId: item.id,
            itemName: item.name,
            tripId: effectiveTripId,
            tripName: item.match.tripName,
            uploaded: 0,
            failed: item.imageCount,
            photoUrls: [],
            error: err instanceof Error ? err.message : "failed",
          },
        ]);
      } finally {
        setConfirmingId(null);
      }
    }

    toast.success("Импорт дууслаа.");
    onComplete?.();
  }

  function downloadReport() {
    if (!results || results.length === 0) return;
    const lines = [
      "Аяллын зураг импортын тайлан",
      "",
      ...results.map((r) => {
        const status = r.error ? "АМЖИЛТГҮЙ" : "АМЖИЛТТАЙ";
        return [
          `${r.itemName} → ${r.tripName || "сонгоогүй"} [${status}]`,
          `  Оруулсан: ${r.uploaded}, Амжилтгүй: ${r.failed}`,
          r.error ? `  Алдаа: ${r.error}` : `  URL-үүд: ${r.photoUrls.join(", ")}`,
        ].join("\n");
      }),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-report-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function statusTone(confidence: MatchResult["confidence"], hasError?: boolean): React.ComponentProps<typeof Badge>["tone"] {
    if (hasError) return "danger";
    switch (confidence) {
      case "high":
        return "success";
      case "medium":
        return "warning";
      case "low":
        return "warning";
      default:
        return "neutral";
    }
  }

  function statusLabel(confidence: MatchResult["confidence"], hasError?: boolean): string {
    if (hasError) return "Алдаа";
    switch (confidence) {
      case "high":
        return "Таарлаа";
      case "medium":
        return "Шалгах";
      case "low":
        return "Эргэлзээтэй";
      default:
        return "Таарахгүй";
    }
  }

  if (results) {
    const successCount = results.filter((r) => !r.error && r.uploaded > 0).length;
    const failCount = results.filter((r) => r.error).length;
    return (
      <div className="space-y-4">
        <Card>
          <div className="p-4">
            <h2 className="text-lg font-semibold text-ink">Импортын дүн</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Амжилттай: {successCount} · Амжилтгүй: {failCount} · Нийт: {results.length}
            </p>
            <div className="mt-4 flex gap-2">
              <Button onClick={reset}>Шинэ импорт</Button>
              <Button variant="secondary" onClick={downloadReport}>
                Тайлан татах
              </Button>
            </div>
          </div>
        </Card>
        <div className="space-y-2">
          {results.map((r) => (
            <Card key={r.itemId}>
              <div className="flex items-start gap-3 p-3">
                <div className="mt-0.5">
                  {r.error ? (
                    <Icons.alert size={18} className="text-red-500" />
                  ) : (
                    <Icons.check size={18} className="text-green-500" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{r.itemName}</p>
                  <p className="text-xs text-ink-muted">
                    {r.tripName || "Аялал сонгоогүй"} · Оруулсан: {r.uploaded} · Амжилтгүй: {r.failed}
                  </p>
                  {r.error && <p className="mt-1 text-xs text-red-600">{r.error}</p>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="p-4">
          <h2 className="text-lg font-semibold text-ink">Аяллын зураг оруулах</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Олон zip файл, хавтас эсвэл зураг шууд чирж оруулна. Систем автоматаар
            аялалд тааруулж, баталгаажуулсаны дараа Cloudinary руу оруулна.
          </p>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={cx(
              "mt-4 cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition-colors",
              dragging
                ? "border-brand bg-brand/5"
                : "border-line-strong bg-surface-sunken hover:border-brand",
            )}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icons.upload size={32} className="mx-auto text-ink-muted" />
            <p className="mt-2 text-sm font-medium text-ink">Чирж оруулах эсвэл дарж сонгох</p>
            <p className="mt-1 text-xs text-ink-muted">.zip, .jpg, .jpeg, .png, .webp (бүр хавтас ч болно)</p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".zip,image/*"
            className="hidden"
            onChange={handleFileSelect}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFolderSelect}
            {...{ webkitdirectory: "true", directory: "true" }}
          />

          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
              Файл сонгох
            </Button>
            <Button variant="secondary" size="sm" onClick={() => folderInputRef.current?.click()}>
              Хавтас сонгох
            </Button>
          </div>
        </div>
      </Card>

      {busy && (
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          Урьдчилан харж байна...
        </div>
      )}

      {previewErrors.length > 0 && (
        <Alert tone="warning">
          <ul className="list-disc space-y-1 pl-4 text-sm">
            {previewErrors.map((err, idx) => (
              <li key={idx}>{err}</li>
            ))}
          </ul>
        </Alert>
      )}

      {items.length > 0 && (
        <>
          <Card>
            <div className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="font-semibold text-ink">Тааруулалт шалгах ({items.length} импорт)</h3>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-ink-muted">Цувах арга:</span>
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as "append" | "replace")}
                    className="rounded-lg border border-line-strong bg-surface-sunken px-2 py-1 text-sm text-ink"
                  >
                    <option value="append">Одоо байгаа зурган дээр нэмэх</option>
                    <option value="replace">Одоо байгаа зургийг солих</option>
                  </select>
                </div>
              </div>

              {hasUnassigned && (
                <div className="mt-3">
                  <Alert tone="warning">
                    Зарим мөрөнд тохирох аялал олдоогүй эсвэл сонгоогүй байна. Алгасах эсвэл гараар сонгоно уу.
                  </Alert>
                </div>
              )}

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-ink-muted">
                    <tr>
                      <th className="pb-2 font-medium">Файл / хавтас</th>
                      <th className="pb-2 font-medium">Зураг</th>
                      <th className="pb-2 font-medium">Тааруулалт</th>
                      <th className="pb-2 font-medium">Аялал сонгох</th>
                      <th className="pb-2 font-medium">Алгасах</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {items.map((item) => {
                      const effectiveTripId = getEffectiveTripId(item);
                      const isSkipped = skipped.has(item.id);
                      const duplicateTrip = item.duplicateTripItemIds.length > 0;
                      return (
                        <tr key={item.id} className={cx(isSkipped && "opacity-50")}>
                          <td className="py-3 pr-3 align-top">
                            <div className="flex items-center gap-2">
                              {item.sourceType === "zip" ? (
                                <Icons.file size={16} className="text-ink-muted" />
                              ) : (
                                <Icons.image size={16} className="text-ink-muted" />
                              )}
                              <span className="max-w-[12rem] truncate font-medium text-ink">
                                {item.name}
                              </span>
                            </div>
                            {item.error && (
                              <p className="mt-1 text-xs text-red-600">{item.error}</p>
                            )}
                            {duplicateTrip && (
                              <p className="mt-1 text-xs text-amber-600">
                                Анхааруулга: өөр zip-ээс ижил аялалд таарсан
                              </p>
                            )}
                          </td>
                          <td className="py-3 pr-3 align-top text-ink-muted">
                            <div className="text-xs">{item.imageCount} ширхэг</div>
                            <div className="mt-1 flex max-w-[12rem] gap-1 overflow-x-auto">
                              {item.imageIds.slice(0, 4).map((imageId) => (
                                <img
                                  key={imageId}
                                  src={`/api/admin/trip-photos-thumbnail?batchId=${batchId}&imageId=${imageId}&w=48`}
                                  alt=""
                                  className="h-10 w-10 rounded-md border border-line object-cover"
                                  loading="lazy"
                                />
                              ))}
                              {item.imageIds.length > 4 && (
                                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line bg-surface-sunken text-[10px] text-ink-muted">
                                  +{item.imageIds.length - 4}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-3 pr-3 align-top">
                            <div className="space-y-1">
                              <Badge tone={statusTone(item.match.confidence, !!item.error)}>
                                {statusLabel(item.match.confidence, !!item.error)}
                              </Badge>
                              {item.match.tripId && (
                                <p className="max-w-[12rem] truncate text-xs text-ink-muted">
                                  {item.match.tripName}
                                </p>
                              )}
                              <p className="max-w-[12rem] truncate text-xs text-ink-subtle">
                                {item.match.reason}
                              </p>
                            </div>
                          </td>
                          <td className="py-3 pr-3 align-top">
                            <select
                              value={effectiveTripId ?? ""}
                              disabled={isSkipped}
                              onChange={(e) =>
                                setOverride(item.id, e.target.value || null)
                              }
                              className="w-full max-w-[14rem] rounded-lg border border-line-strong bg-surface-sunken px-2 py-1 text-sm text-ink disabled:opacity-50"
                            >
                              <option value="">-- Аялал сонгох --</option>
                              {sortedTrips.map((trip) => (
                                <option key={trip.id} value={trip.id}>
                                  {trip.route_name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-3 align-top">
                            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                              <input
                                type="checkbox"
                                checked={isSkipped}
                                onChange={() => toggleSkip(item.id)}
                                className="h-4 w-4 rounded border-line-strong accent-brand"
                              />
                              Алгасах
                            </label>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <Button variant="secondary" onClick={reset}>
                  Дахин эхлэх
                </Button>
                <Button
                  loading={confirmingId != null}
                  disabled={hasUnassigned || busy}
                  onClick={() => void confirmImport()}
                >
                  {confirmingId ? "Оруулж байна..." : "Баталгаажуулах"}
                </Button>
              </div>
            </div>
          </Card>

          {confirmingId && (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
              Оруулж хадгалж байна...
            </div>
          )}
        </>
      )}
    </div>
  );
}
