import { useState } from "react";
import { Button, Icons, Textarea, cx } from "@/components/ui";
import {
  CHECKUP_LIST_TITLES,
  checkupItemCount,
  composeHealthCheckup,
  splitHealthCheckup,
  type CheckupGroup,
  type CheckupList,
} from "@/lib/healthCheckup";

const INPUT = "h-9 w-full min-w-0 rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink placeholder:text-ink-subtle focus:border-brand";
const emptyGroup = (title = ""): CheckupGroup => ({ title, items: [{ label: "", detail: null }], notes: [] });

/**
 * The trip description as the website shows it. For a health-checkup trip the
 * description also holds the clinic's test list; the website splits it out into
 * an "Эрүүл мэндийн шинжилгээ" section of grouped cards (src/lib/healthCheckup.ts,
 * same parser), so it is edited here the same way: the intro as text, the tests
 * as audiences → groups → tests. Everything is saved back as the one description
 * text both the website and the bot read. Nothing is written until staff edit.
 */
export function TripDescriptionEditor({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const initial = splitHealthCheckup(value);
  const [intro, setIntro] = useState(initial.lists.length ? initial.intro : value);
  const [lists, setLists] = useState<CheckupList[]>(initial.lists);
  const [active, setActive] = useState(0);
  const [asText, setAsText] = useState(false);
  const [raw, setRaw] = useState(value);

  function commit(nextIntro: string, nextLists: CheckupList[]) {
    setIntro(nextIntro);
    setLists(nextLists);
    onChange(nextLists.length ? composeHealthCheckup({ intro: nextIntro, lists: nextLists }) : nextIntro);
  }
  function updateList(index: number, patch: (list: CheckupList) => CheckupList) {
    commit(intro, lists.map((list, i) => (i === index ? patch(list) : list)));
  }
  function updateGroup(groupIndex: number, patch: (group: CheckupGroup) => CheckupGroup) {
    updateList(active, (list) => ({ ...list, groups: list.groups.map((group, i) => (i === groupIndex ? patch(group) : group)) }));
  }
  function addList(audience: string) {
    const next = [...lists, { title: CHECKUP_LIST_TITLES[audience], audience, groups: [emptyGroup("Үндсэн үзлэг")], notes: [] }];
    commit(intro, next);
    setActive(next.length - 1);
  }

  if (asText) {
    return (
      <div className="space-y-2">
        <Textarea aria-label="Аяллын тайлбар (бүтэн текст)" rows={12} className="[field-sizing:content] min-h-48 font-mono text-[13px]"
          value={raw} onChange={(e) => { setRaw(e.target.value); onChange(e.target.value); }} />
        <p className="text-xs text-ink-muted">
          Шинжилгээний жагсаалт: «…шинжилгээнд багтсан зүйлс» гэсэн гарчиг, бүлгийн нэр «:»-ээр төгссөн мөр, шинжилгээ тус бүр нэг мөрөнд, «Жич:» тэмдэглэл.
        </p>
        <Button size="sm" variant="secondary" onClick={() => {
          const split = splitHealthCheckup(raw);
          setIntro(split.lists.length ? split.intro : raw);
          setLists(split.lists);
          setActive(0);
          setAsText(false);
        }}>
          Бүлгээр харах
        </Button>
      </div>
    );
  }

  const list = lists[Math.min(active, lists.length - 1)];
  return (
    <div className="space-y-4">
      <Textarea aria-label="Аяллын тайлбар" rows={lists.length ? 4 : 6} className="[field-sizing:content] min-h-28"
        value={intro} onChange={(e) => commit(e.target.value, lists)} />

      {list ? (
        <section aria-label="Эрүүл мэндийн шинжилгээ" className="rounded-xl border border-line bg-canvas/50 p-3.5 sm:p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand">{checkupItemCount(list)} төрлийн үзлэг, шинжилгээ</p>
              <h3 className="mt-1 text-base font-semibold text-ink">Эрүүл мэндийн шинжилгээ</h3>
              <p className="mt-0.5 text-xs text-ink-muted">Вэбсайт дээр яг ийм бүлгүүдээр харагдана.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {lists.length > 1 && (
                <div role="tablist" aria-label="Хэнд зориулсан жагсаалт" className="inline-flex rounded-full border border-line bg-surface p-1">
                  {lists.map((entry, index) => (
                    <button key={`${entry.title}-${index}`} type="button" role="tab" aria-selected={index === active} onClick={() => setActive(index)}
                      className={cx("rounded-full px-3.5 py-1 text-sm font-semibold transition-colors",
                        index === active ? "bg-brand text-white" : "text-ink-muted hover:text-ink")}>
                      {entry.audience}
                      <span className="ml-1.5 text-xs font-medium opacity-75">{checkupItemCount(entry)}</span>
                    </button>
                  ))}
                </div>
              )}
              {(["Эрэгтэй", "Эмэгтэй", "Хүүхэд"] as const).filter((audience) => !lists.some((entry) => entry.audience === audience)).map((audience) => (
                <Button key={audience} size="sm" variant="ghost" onClick={() => addList(audience)}>
                  <Icons.plus size={13} /> {audience}
                </Button>
              ))}
            </div>
          </div>

          <div className="mt-4 gap-3 sm:columns-2">
            {list.groups.map((group, groupIndex) => (
              <div key={groupIndex} className="mb-3 break-inside-avoid rounded-xl border border-line bg-surface p-3.5">
                <div className="flex items-center gap-2">
                  <input aria-label="Бүлгийн нэр" placeholder="Бүлгийн нэр (ж: Цусны шинжилгээ)" value={group.title}
                    onChange={(e) => updateGroup(groupIndex, (g) => ({ ...g, title: e.target.value }))}
                    className={cx(INPUT, "font-semibold")} />
                  <span className="shrink-0 text-xs font-medium tabular-nums text-ink-muted">{group.items.filter((item) => item.label.trim()).length}</span>
                  <button type="button" aria-label="Бүлгийг устгах" title="Бүлгийг устгах"
                    onClick={() => updateList(active, (l) => ({ ...l, groups: l.groups.filter((_, i) => i !== groupIndex) }))}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-danger-soft hover:text-danger">
                    <Icons.trash size={14} />
                  </button>
                </div>
                {group.notes.map((note, noteIndex) => (
                  <div key={noteIndex} className="mt-2 flex items-start gap-1.5 rounded-lg bg-sun-soft px-2.5 py-1.5">
                    <Icons.info size={13} className="mt-1.5 shrink-0 text-warning" />
                    <input aria-label="Жич" value={note} className="h-7 min-w-0 flex-1 bg-transparent text-xs text-ink outline-none"
                      onChange={(e) => updateGroup(groupIndex, (g) => ({ ...g, notes: g.notes.map((n, i) => (i === noteIndex ? e.target.value : n)) }))} />
                    <button type="button" aria-label="Жич устгах" className="mt-1 text-ink-muted hover:text-danger"
                      onClick={() => updateGroup(groupIndex, (g) => ({ ...g, notes: g.notes.filter((_, i) => i !== noteIndex) }))}>
                      <Icons.close size={13} />
                    </button>
                  </div>
                ))}
                <ul className="mt-2.5 space-y-1.5">
                  {group.items.map((item, itemIndex) => (
                    <li key={itemIndex} className="flex items-center gap-1.5">
                      <Icons.check size={15} className="shrink-0 text-success" />
                      <input aria-label="Шинжилгээ" placeholder="Шинжилгээний нэр" value={item.label} title={item.label} className={cx(INPUT, "basis-0 flex-[3]")}
                        onChange={(e) => updateGroup(groupIndex, (g) => ({ ...g, items: g.items.map((it, i) => (i === itemIndex ? { ...it, label: e.target.value } : it)) }))} />
                      <input aria-label="Дэлгэрэнгүй" placeholder="дэлгэрэнгүй (заавал биш)" value={item.detail ?? ""} title={item.detail ?? undefined} className={cx(INPUT, "hidden basis-0 flex-[2] sm:block")}
                        onChange={(e) => updateGroup(groupIndex, (g) => ({ ...g, items: g.items.map((it, i) => (i === itemIndex ? { ...it, detail: e.target.value || null } : it)) }))} />
                      <button type="button" aria-label="Шинжилгээг устгах" className="flex h-8 w-7 shrink-0 items-center justify-center text-ink-muted hover:text-danger"
                        onClick={() => updateGroup(groupIndex, (g) => ({ ...g, items: g.items.filter((_, i) => i !== itemIndex) }))}>
                        <Icons.close size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => updateGroup(groupIndex, (g) => ({ ...g, items: [...g.items, { label: "", detail: null }] }))}>
                    <Icons.plus size={13} /> Шинжилгээ
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => updateGroup(groupIndex, (g) => ({ ...g, notes: [...g.notes, ""] }))}>
                    <Icons.plus size={13} /> Жич
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="secondary" onClick={() => updateList(active, (l) => ({ ...l, groups: [...l.groups, emptyGroup()] }))}>
                <Icons.plus size={13} /> Бүлэг нэмэх
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setRaw(composeHealthCheckup({ intro, lists })); setAsText(true); }}>
                Бүтэн текстээр засах
              </Button>
            </div>
            <Button size="sm" variant="ghost" className="text-danger"
              onClick={() => { commit(intro, lists.filter((_, i) => i !== active)); setActive(0); }}>
              <Icons.trash size={13} /> «{list.audience}» жагсаалт устгах
            </Button>
          </div>
        </section>
      ) : (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => addList("Шинжилгээ")}>
            <Icons.plus size={13} /> Эрүүл мэндийн шинжилгээний жагсаалт нэмэх
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setRaw(intro); setAsText(true); }}>
            Шинжилгээний жагсаалт текстээр буулгах
          </Button>
        </div>
      )}
    </div>
  );
}
