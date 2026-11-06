/**
 * The hotels a trip sells, each with its link, a short description and photos.
 * The website's "Байрлах буудал" cards and the itinerary's hotel links read
 * exactly this (extra.hotel_profiles); until 2026-11-05 nothing in the admin
 * could fill it, so every hotel link on the site was empty.
 *
 * Hotels named in the price rows or on the trip but not described yet are
 * offered as one-click additions.
 */
import { Icons } from "@/components/ui";
import type { HotelProfile } from "@/lib/adminTypes";
import { ListEditor } from "../TripEditorParts";
import { AddRowButton, EmptyHint, Field, RowCard, TextArea, TextInput } from "./parts";

const squash = (value: string) => value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");

/** Hotel names a trip mentions: price rows ("Hotel · Package" keeps the hotel part) and the trip's hotel line. */
export function hotelNamesOf(priceGroups: Array<{ hotel?: string | null }>, tripHotel: string): string[] {
  const names = [
    ...priceGroups.map((group) => String(group.hotel || "").split(" · ")[0]),
    ...String(tripHotel || "").split(/,|\s+эсвэл\s+|\s+or\s+|\//i),
  ].map((name) => name.trim())
    // "Норвел хотын буудал, 4 од": the part after the comma is the hotel's stars, not another hotel.
    .filter((name) => name.length >= 2 && !/^(\d+\s*(?:од(?:той)?|\*|star)s?|\d+\*)$/iu.test(name) && /\p{L}{3,}/u.test(name));
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = squash(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validUrl(value: string): boolean {
  if (!value.trim()) return true;
  try { return new URL(value.trim()).protocol === "https:"; } catch { return false; }
}

export function HotelProfilesEditor({
  profiles,
  onChange,
  suggestions = [],
}: {
  profiles: HotelProfile[];
  onChange: (profiles: HotelProfile[]) => void;
  suggestions?: string[];
}) {
  const described = new Set(profiles.map((profile) => squash(profile.name)));
  // "Norvel Grand" and "Norvelgrand" are the same hotel: a suggestion already described under another spelling is not offered.
  const offered = suggestions.filter((name) => !described.has(squash(name)));
  const patch = (index: number, next: Partial<HotelProfile>) => onChange(profiles.map((profile, i) => (i === index ? { ...profile, ...next } : profile)));
  const add = (name = "") => onChange([...profiles, { name, url: "", description: "", media: [] }]);

  return (
    <div className="space-y-3">
      {offered.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-muted">Аялалд нэрлэгдсэн:</span>
          {offered.map((name) => (
            <button key={name} type="button" onClick={() => add(name)}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 text-xs font-medium text-ink-muted transition-colors hover:border-brand hover:text-brand">
              <Icons.plus size={11} /> {name}
            </button>
          ))}
        </div>
      )}
      {profiles.length === 0 ? (
        <EmptyHint>Буудлын холбоос, зураг оруулаагүй байна. Вэбсайт дээр буудлын картанд харагдана.</EmptyHint>
      ) : profiles.map((profile, index) => (
        <RowCard key={index} title={profile.name || `Буудал ${index + 1}`} removeLabel="Буудал хасах" onRemove={() => onChange(profiles.filter((_, i) => i !== index))}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Нэр"><TextInput value={profile.name} placeholder="ж: Далайн эргийн 5* буудал" onChange={(e) => patch(index, { name: e.target.value })} /></Field>
            <Field label="Холбоос" hint={!profile.url.trim() || validUrl(profile.url) ? "Буудлын албан ёсны хуудас эсвэл захиалгын сайт (https://…). Заавал биш." : "https:// гэж эхэлсэн бүтэн холбоос оруулна уу — өөр холбоос хадгалагдахгүй."}>
              <TextInput value={profile.url} missing={Boolean(profile.url.trim()) && !validUrl(profile.url)} placeholder="https://…" inputMode="url" onChange={(e) => patch(index, { url: e.target.value })} />
            </Field>
            <Field label="Тайлбар" className="sm:col-span-2">
              <TextArea rows={2} value={profile.description} placeholder="Байршил, од, онцлог (заавал биш)" onChange={(e) => patch(index, { description: e.target.value })} />
            </Field>
            <Field label="Зургийн холбоосууд" className="sm:col-span-2"
              hint={profile.media.some((item) => item.url.trim() && !validUrl(item.url)) ? "https:// биш зураг хадгалагдахгүй — https холбоос оруулна уу." : "Мөр бүрт нэг зураг (https://…)."}>
              <ListEditor ariaLabel="Буудлын зураг" addLabel="Зураг нэмэх" placeholder="https://…"
                items={profile.media.map((item) => item.url)}
                // Captions follow their photo by link: by position, deleting a photo moved every later caption.
                onChange={(urls) => {
                  const captions = new Map(profile.media.map((item) => [item.url, item.caption]));
                  patch(index, { media: urls.map((url) => ({ url, caption: captions.get(url) || "" })) });
                }} />
            </Field>
          </div>
        </RowCard>
      ))}
      <AddRowButton label="Буудал нэмэх" onClick={() => add()} />
    </div>
  );
}
