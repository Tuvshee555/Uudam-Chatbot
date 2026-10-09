import { useState } from "react";
import { Button, Card, Input, useToast } from "@/components/ui";
import type { TravelBotSettings } from "@/lib/adminTypes";
import { contactSettingsOf } from "@/lib/contactReplies";

/**
 * What the bot answers to the page's "Холбоо барих дугаар" and "Манай хаяг"
 * buttons. Without an address here the bot sends the phone numbers and asks
 * the customer to check the address with staff — it never makes one up.
 */
export function ContactInfoCard({
  settings,
  apiFetch,
  onSettingsChanged,
}: {
  settings: TravelBotSettings | null;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onSettingsChanged: () => void;
}) {
  const toast = useToast();
  const saved = contactSettingsOf(settings?.extra);
  const [phones, setPhones] = useState(saved.phones);
  const [address, setAddress] = useState(saved.address);
  const [busy, setBusy] = useState(false);
  const dirty = phones.trim() !== saved.phones || address.trim() !== saved.address;

  async function save() {
    setBusy(true);
    try {
      const res = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { extra: { contact_phones: phones.trim(), office_address: address.trim() } } }),
      });
      if (!res.ok) throw new Error("save failed");
      onSettingsChanged();
      toast.success("Холбоо барих мэдээлэл хадгалагдлаа.");
    } catch {
      toast.error("Хадгалахад алдаа гарлаа.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-ink">Холбоо барих мэдээлэл</p>
      <p className="mt-0.5 text-xs text-ink-subtle">
        Хэрэглэгч &ldquo;Холбоо барих дугаар&rdquo;, &ldquo;Манай хаяг&rdquo; товч дарахад бот яг энэ мэдээллийг илгээнэ.
      </p>
      <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface-sunken p-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-muted">Утасны дугаарууд</span>
          <Input value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="Жишээ: 7713 6633 / 8913 6633" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-ink-muted">Оффисын хаяг</span>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Дүүрэг, хороо, гудамж, байр, тоот" />
        </label>
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? "Хадгалж байна…" : "Хадгалах"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
