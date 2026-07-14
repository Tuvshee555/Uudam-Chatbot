import { useEffect, useRef, useState } from "react";
import { Button, Card, EmptyState, Icons, Input, Modal, Spinner, Textarea, useToast } from "@/components/ui";
import type { FlowRule } from "@/lib/adminTypes";
import { SectionHeading } from "./AdminShared";
import { BLANK_FLOW_RULE } from "./adminTabData";
export function FlowBuilderTab({
  extra,
  apiFetch,
  onSaved,
}: {
  extra: Record<string, unknown>;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onSaved: () => void;
}) {
  const toast = useToast();

  const [rules, setRules] = useState<FlowRule[]>(() => {
    if (Array.isArray(extra.flows)) {
      return extra.flows as FlowRule[];
    }
    return [];
  });

  // Re-sync rules when extra prop changes (e.g. after loadAll)
  const extraRef = useRef(extra);
  useEffect(() => {
    if (extraRef.current !== extra) {
      extraRef.current = extra;
      if (Array.isArray(extra.flows)) {
        setRules(extra.flows as FlowRule[]);
      }
    }
  }, [extra]);

  const [editing, setEditing] = useState<FlowRule | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<FlowRule>>(BLANK_FLOW_RULE);
  const [saving, setSaving] = useState(false);

  async function saveRules(newRules: FlowRule[]) {
    setSaving(true);
    try {
      const res = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extra: { ...extra, flows: newRules } }),
      });
      if (!res.ok) {
        toast.error("Урсгал хадгалж чадсангүй.");
        return;
      }
      setRules(newRules);
      onSaved();
      toast.success("Урсгал хадгалагдлаа.");
    } catch {
      toast.error("Урсгал хадгалж чадсангүй.");
    } finally {
      setSaving(false);
    }
  }

  function openNew() {
    setEditing({ id: "", ...BLANK_FLOW_RULE });
    setEditDraft({ ...BLANK_FLOW_RULE, buttons: [] });
  }

  function openEdit(rule: FlowRule) {
    setEditing(rule);
    setEditDraft({ ...rule, buttons: [...rule.buttons] });
  }

  function closeModal() {
    setEditing(null);
    setEditDraft(BLANK_FLOW_RULE);
  }

  async function handleSaveRule() {
    const keywords = (editDraft.keywords || "").trim();
    const reply = (editDraft.reply || "").trim();
    if (!keywords || !reply) {
      toast.error("Түлхүүр үг болон хариулт заавал бөглөнө үү.");
      return;
    }
    const buttons = (editDraft.buttons || []).map((b) => b.trim()).filter(Boolean);
    if (editing!.id) {
      // edit existing
      const newRules = rules.map((r) =>
        r.id === editing!.id ? { ...r, keywords, reply, buttons } : r,
      );
      await saveRules(newRules);
    } else {
      // add new
      const newRule: FlowRule = {
        id: Date.now().toString(36),
        keywords,
        reply,
        buttons,
      };
      await saveRules([...rules, newRule]);
    }
    closeModal();
  }

  async function handleDelete(id: string) {
    await saveRules(rules.filter((r) => r.id !== id));
  }

  function updateDraftButton(index: number, value: string) {
    const next = [...(editDraft.buttons || [])];
    next[index] = value;
    setEditDraft((prev) => ({ ...prev, buttons: next }));
  }

  function addDraftButton() {
    if ((editDraft.buttons || []).length >= 4) return;
    setEditDraft((prev) => ({ ...prev, buttons: [...(prev.buttons || []), ""] }));
  }

  function removeDraftButton(index: number) {
    const next = (editDraft.buttons || []).filter((_, i) => i !== index);
    setEditDraft((prev) => ({ ...prev, buttons: next }));
  }

  return (
    <div className="max-w-2xl space-y-4">
      <SectionHeading
        title="Урсгал"
        description="Хэрэглэгч хэлэхэд → Бот хариулна. Түлхүүр үгтэй мессеж илрэхэд AI-г тойрч хариу илгээнэ."
        action={
          <Button size="sm" variant="primary" onClick={openNew} disabled={saving}>
            <Icons.plus size={15} />
            Дүрэм нэмэх
          </Button>
        }
      />

      {rules.length === 0 && (
        <EmptyState
          title="Дүрэм байхгүй байна"
          description="«Дүрэм нэмэх» товчоор эхний дүрмээ үүсгээрэй."
        />
      )}

      <div className="space-y-2">
        {rules.map((rule) => (
          <Card key={rule.id} className="card-lift p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap gap-1">
                  {rule.keywords
                    .split(",")
                    .map((k) => k.trim())
                    .filter(Boolean)
                    .map((k) => (
                      <span
                        key={k}
                        className="inline-flex items-center rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand"
                      >
                        {k}
                      </span>
                    ))}
                </div>
                <p className="truncate text-sm text-ink">
                  <span className="mr-1 text-ink-muted">→</span>
                  {rule.reply}
                </p>
                {rule.buttons.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {rule.buttons.map((btn) => (
                      <span
                        key={btn}
                        className="inline-flex items-center rounded border border-line-strong bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted"
                      >
                        {btn}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => openEdit(rule)}
                  disabled={saving}
                >
                  <Icons.edit size={14} />
                  Засах
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onClick={() => void handleDelete(rule.id)}
                  disabled={saving}
                >
                  <Icons.trash size={14} />
                  Устгах
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {editing !== null && (
        <Modal
          open={editing !== null}
          title={editing.id ? "Дүрэм засах" : "Шинэ дүрэм нэмэх"}
          onClose={closeModal}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeModal} disabled={saving}>
                Цуцлах
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleSaveRule()}
                disabled={saving}
              >
                {saving ? <Spinner className="h-4 w-4" /> : null}
                Хадгалах
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-ink">
                Түлхүүр үгс
                <span className="ml-1 text-xs font-normal text-ink-muted">
                  (таслалаар тусгаарлана)
                </span>
              </label>
              <Input
                className="mt-1"
                placeholder="захиалах, book, захиалга"
                value={editDraft.keywords || ""}
                onChange={(e) =>
                  setEditDraft((prev) => ({ ...prev, keywords: e.target.value }))
                }
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-ink">
                Бот хариулах текст
              </label>
              <Textarea
                className="mt-1"
                rows={3}
                placeholder="Бот хариулах текст"
                value={editDraft.reply || ""}
                onChange={(e) =>
                  setEditDraft((prev) => ({ ...prev, reply: e.target.value }))
                }
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-ink">
                  Товчлуурууд
                  <span className="ml-1 text-xs font-normal text-ink-muted">
                    (хамгийн ихдээ 4)
                  </span>
                </label>
                {(editDraft.buttons || []).length < 4 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={addDraftButton}
                  >
                    <Icons.plus size={14} />
                    Нэмэх
                  </Button>
                )}
              </div>
              <div className="mt-1 space-y-2">
                {(editDraft.buttons || []).length === 0 && (
                  <p className="text-xs text-ink-subtle">
                    Товчлуур нэмэхгүй бол хоосон үлдэж болно.
                  </p>
                )}
                {(editDraft.buttons || []).map((btn, index) => (
                  <div key={index} className="flex gap-2">
                    <Input
                      className="flex-1"
                      placeholder={`Товчлуур ${index + 1}`}
                      value={btn}
                      onChange={(e) => updateDraftButton(index, e.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      onClick={() => removeDraftButton(index)}
                    >
                      <Icons.trash size={14} />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
