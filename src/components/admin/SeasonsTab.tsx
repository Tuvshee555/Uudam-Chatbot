import { useEffect, useRef, useState } from "react";
import { Button, Card, Icons, Input, Spinner, cx, useToast } from "@/components/ui";
import { readSeasons, type SeasonItem } from "./adminTabData";
export function SeasonsTab({
  extra,
  apiFetch,
  onSaved,
}: {
  extra: Record<string, unknown>;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [seasons, setSeasons] = useState<SeasonItem[]>(() => readSeasons(extra));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Re-sync local state when extra prop changes (e.g. after loadAll).
  const extraRef = useRef(extra);
  useEffect(() => {
    if (extraRef.current !== extra) {
      extraRef.current = extra;
      setSeasons(readSeasons(extra));
    }
  }, [extra]);

  async function saveSeasons(next: SeasonItem[]) {
    setSaving(true);
    try {
      const res = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extra: { ...extra, seasons: next } }),
      });
      if (!res.ok) {
        toast.error("Улирал хадгалж чадсангүй.");
        return;
      }
      setSeasons(next);
      onSaved();
      toast.success("Улирал хадгалагдлаа.");
    } catch {
      toast.error("Улирал хадгалж чадсангүй.");
    } finally {
      setSaving(false);
    }
  }

  function addSeason() {
    const next: SeasonItem[] = [
      ...seasons,
      {
        id: Date.now().toString(36),
        name: "",
        keywords: [],
        photoUrls: [],
        active: false,
      },
    ];
    void saveSeasons(next);
  }

  function updateSeason(id: string, patch: Partial<SeasonItem>) {
    setSeasons((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function removeSeason(id: string) {
    setSeasons((prev) => prev.filter((s) => s.id !== id));
  }

  function toggleActive(id: string) {
    setSeasons((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, active: !s.active } : { ...s, active: false },
      ),
    );
  }

  async function uploadSeasonFiles(seasonId: string, files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => f.size <= 10 * 1024 * 1024);
    if (!arr.length) return;
    setUploading((p) => [...p, ...arr.map((f) => f.name)]);
    for (const file of arr) {
      try {
        const sigRes = await apiFetch("/api/admin/upload-image", { method: "POST" });
        if (!sigRes.ok) throw new Error("upload not configured");
        const sig = (await sigRes.json()) as {
          signature: string;
          timestamp: number;
          cloudName: string;
          apiKey: string;
          folder: string;
        };
        const fd = new FormData();
        fd.append("file", file);
        fd.append("api_key", sig.apiKey);
        fd.append("timestamp", String(sig.timestamp));
        fd.append("signature", sig.signature);
        fd.append("folder", sig.folder);
        const up = await fetch(
          `https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`,
          { method: "POST", body: fd },
        );
        const upJson = (await up.json()) as { secure_url?: string };
        if (!up.ok || !upJson.secure_url) throw new Error("cloudinary failed");
        const url = upJson.secure_url;
        setSeasons((prev) =>
          prev.map((s) =>
            s.id === seasonId ? { ...s, photoUrls: [...s.photoUrls, url] } : s,
          ),
        );
      } catch {
        toast.error(`"${file.name}" зураг оруулж чадсангүй.`);
      } finally {
        setUploading((p) => p.filter((n) => n !== file.name));
      }
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* Hero header */}
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand">
          <Icons.refresh size={20} />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-ink">Улирал</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-ink-muted">
            Улирлын аялал — тухайн улиралд (ж: зун Наадам) онцлох зургуудыг
            тохируулна. Нэг улирлыг идэвхтэй болгоход мэндчилгээнд тэр улирлын
            зургууд нэмж илгээгдэнэ. Хэрэглэгч уг улирлын нэрийг бичихэд бот
            зургуудыг автоматаар илгээнэ.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Button variant="secondary" onClick={addSeason} disabled={saving}>
          <Icons.plus size={16} /> Улирал нэмэх
        </Button>
        {seasons.length > 0 && (
          <Button onClick={() => void saveSeasons(seasons)} disabled={saving}>
            {saving ? "Хадгалж байна…" : "Хадгалах"}
          </Button>
        )}
      </div>

      {seasons.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
            <Icons.refresh size={22} />
          </div>
          <p className="text-sm font-semibold text-ink">Улирал нэмээгүй байна</p>
          <p className="max-w-sm text-xs text-ink-subtle">
            “Улирал нэмэх” дарж эхний улирлаа (ж: Наадам) үүсгэнэ үү.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {seasons.map((season) => (
            <Card key={season.id} className="space-y-4 p-4">
              {/* Top row: name + active toggle + delete */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-[200px] flex-1">
                  <label className="mb-1 block text-xs font-medium text-ink-muted">
                    Улирлын нэр
                  </label>
                  <Input
                    placeholder='ж: "Наадам"'
                    value={season.name}
                    onChange={(e) => updateSeason(season.id, { name: e.target.value })}
                  />
                </div>
                <div className="flex items-center gap-3 pt-5">
                  <div className="flex items-center gap-2">
                    <span
                      className={cx(
                        "text-xs font-medium",
                        season.active ? "text-success" : "text-ink-subtle",
                      )}
                    >
                      Идэвхтэй
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={season.active}
                      onClick={() => toggleActive(season.id)}
                      className={cx(
                        "relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none",
                        season.active ? "bg-brand" : "bg-line-strong",
                      )}
                      aria-label="Улирал идэвхжүүлэх"
                    >
                      <span
                        className={cx(
                          "inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200",
                          season.active ? "translate-x-7" : "translate-x-0",
                        )}
                      />
                    </button>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => removeSeason(season.id)}
                    aria-label="Улирал устгах"
                  >
                    <Icons.trash size={15} /> Устгах
                  </Button>
                </div>
              </div>

              {/* Keywords */}
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-muted">
                  Түлхүүр үг
                </label>
                <Input
                  placeholder="наад, наадам, зун"
                  value={season.keywords.join(", ")}
                  onChange={(e) =>
                    updateSeason(season.id, {
                      keywords: e.target.value
                        .split(",")
                        .map((k) => k.trim())
                        .filter(Boolean),
                    })
                  }
                />
                <p className="mt-1.5 text-xs text-ink-subtle">
                  Түлхүүр үг (таслалаар). Монгол хэлний нугаралтыг бодоод ҮНДСЭН
                  хэсгийг бичнэ үү — ж: “наад” (наадам, наадмын), “өвл” (өвөл,
                  өвлийн). Бот эдгээр үгийг агуулсан мессежийг таних болно.
                </p>
              </div>

              {/* Photos */}
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-muted">
                  Улирлын зураг
                </label>
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(season.id);
                  }}
                  onDragLeave={() => setDragging(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(null);
                    void uploadSeasonFiles(season.id, e.dataTransfer.files);
                  }}
                  onClick={() => fileInputRefs.current[season.id]?.click()}
                  className={cx(
                    "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 transition-colors",
                    dragging === season.id
                      ? "border-brand bg-brand-soft"
                      : "border-line-strong bg-surface-sunken hover:border-brand",
                  )}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface text-brand">
                    <Icons.plus size={20} />
                  </div>
                  <p className="text-sm font-medium text-ink">
                    Зураг чирж оруулах эсвэл дарж сонгох
                  </p>
                  <p className="text-xs text-ink-subtle">
                    PNG, JPG, WEBP — хамгийн ихдээ 10MB
                  </p>
                  <input
                    ref={(el) => {
                      fileInputRefs.current[season.id] = el;
                    }}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files)
                        void uploadSeasonFiles(season.id, e.target.files);
                      e.target.value = "";
                    }}
                  />
                </div>

                {uploading.length > 0 && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
                    <Spinner className="h-3.5 w-3.5" />
                    Оруулж байна: {uploading.join(", ")}…
                  </div>
                )}

                {season.photoUrls.length > 0 && (
                  <>
                    <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {season.photoUrls.map((url, idx) => (
                        <div
                          key={idx}
                          className="group relative aspect-square overflow-hidden rounded-xl border border-line"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt="" className="h-full w-full object-cover" />
                          <button
                            type="button"
                            onClick={() =>
                              updateSeason(season.id, {
                                photoUrls: season.photoUrls.filter((_, i) => i !== idx),
                              })
                            }
                            className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-lg bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100"
                            aria-label="Устгах"
                          >
                            <Icons.trash size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-ink-subtle">
                      {season.photoUrls.length}/10 зураг · хамгийн ихдээ 10 илгээгдэнэ.
                    </p>
                  </>
                )}
              </div>
            </Card>
          ))}

          {/* Save bar */}
          <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
            <Button onClick={() => void saveSeasons(seasons)} disabled={saving}>
              {saving ? "Хадгалж байна…" : "Хадгалах"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function readUrlList(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter(
        (u): u is string => typeof u === "string" && u.startsWith("https://"),
      )
    : [];
}

