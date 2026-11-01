/**
 * Health-checkup trips carry the clinic's test list inside the trip description
 * (`notes`, projected to the website's Trip.description): a heading per audience
 * ("Эрэгтэйчүүдийн биеийн шинжилгээ үзлэгт хийх зүйлс"), group headings ending in
 * ":", one test per line and "Жич:" remarks. The website splits it out and shows
 * grouped cards (uudam-booking-web/src/lib/healthCheckup.ts); the admin editor
 * uses the same parser so staff edit what customers see.
 *
 * splitHealthCheckup MUST stay identical to the website's copy: the text is the
 * single source of truth and both sides must read it the same way.
 */
export type CheckupItem = { label: string; detail: string | null };
export type CheckupGroup = { title: string; items: CheckupItem[]; notes: string[] };
export type CheckupList = { title: string; audience: string; groups: CheckupGroup[]; notes: string[] };
export type CheckupSplit = { intro: string; lists: CheckupList[] };

// "...биеийн шинжилгээ үзлэгт хийх зүйлс", "Эмэгтэйчүүдийн шинжилгээнд багтсан зүйлс"
const LIST_HEADING = /(шинжилгээ|үзлэг)\S*\s.*(хийх|багтсан|орох)\s+зүйл/i;
const NOTE = /^жич\s*[:：.-]\s*/i;

function clean(line: string): string {
  return line
    .replace(/[*\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,，;]+$/, "")
    .trim();
}

function audienceOf(title: string): string {
  if (/эрэгтэй/i.test(title)) return "Эрэгтэй";
  if (/эмэгтэй/i.test(title)) return "Эмэгтэй";
  if (/хүүхд/i.test(title)) return "Хүүхэд";
  return "Шинжилгээ";
}

/** A finished sentence, not a test name: "Энэ дээрх 4 төрлийн СТ-ээс сонгоод аль нэгийг өгнө." */
function isSentence(line: string): boolean {
  return /[.!?]$/.test(line) && line.split(" ").length >= 3;
}

export function splitHealthCheckup(text: string | null | undefined): CheckupSplit {
  const lines = String(text ?? "").split(/\r?\n/);
  const intro: string[] = [];
  const lists: CheckupList[] = [];
  // The list and group being filled; notes wait for the group they introduce.
  const at: { list: CheckupList | null; group: CheckupGroup | null; pending: string[] } = { list: null, group: null, pending: [] };

  const openGroup = (list: CheckupList, title: string): CheckupGroup => {
    const group: CheckupGroup = { title, items: [], notes: at.pending };
    at.pending = [];
    list.groups.push(group);
    at.group = group;
    return group;
  };

  for (const raw of lines) {
    const line = clean(raw);
    if (!line) continue;
    if (LIST_HEADING.test(line) && line.length <= 120) {
      at.list?.notes.push(...at.pending);
      at.pending = [];
      const title = line.replace(/[:：]$/, "").trim();
      at.list = { title, audience: audienceOf(title), groups: [], notes: [] };
      at.group = null;
      lists.push(at.list);
      continue;
    }
    const list = at.list;
    if (!list) {
      intro.push(raw.replace(/[*]/g, "").trimEnd());
      continue;
    }
    if (NOTE.test(line)) {
      // "Жич: Бэлгэнд дараах ... шинжилгээг өгч байна." introduces the group below it.
      at.pending.push(line.replace(NOTE, "").trim());
      at.group = null;
      continue;
    }
    if (/[:：]$/.test(line)) {
      openGroup(list, line.replace(/[:：]$/, "").trim());
      continue;
    }
    if (isSentence(line)) {
      if (at.group) at.group.notes.push(line);
      else at.pending.push(line);
      continue;
    }
    const numbered = line.replace(/^\d+\s*[.)]\s*/, "");
    const colon = numbered.search(/[:：]/);
    const item: CheckupItem = colon > 0 && colon < numbered.length - 1
      ? { label: numbered.slice(0, colon).trim(), detail: numbered.slice(colon + 1).trim() }
      : { label: numbered, detail: null };
    (at.group ?? openGroup(list, "")).items.push(item);
  }
  at.list?.notes.push(...at.pending);

  const found = lists.filter((entry) => entry.groups.some((group) => group.items.length > 0));
  // A heading with no tests under it is ordinary text: keep the description whole.
  if (!found.length) return { intro: String(text ?? "").replace(/[*]/g, "").trim(), lists: [] };
  return { intro: intro.join("\n").replace(/\n{3,}/g, "\n\n").trim(), lists: found };
}

/** Number of tests in a list, for the audience switch. */
export function checkupItemCount(list: CheckupList): number {
  return list.groups.reduce((sum, group) => sum + group.items.length, 0);
}

// ─── admin editor: structured list → description text ───────────────────────

/** Titles staff can pick for a new list; each one is read back as a list heading. */
export const CHECKUP_LIST_TITLES: Record<string, string> = {
  Шинжилгээ: "Шинжилгээнд багтсан зүйлс",
  Эрэгтэй: "Эрэгтэйчүүдийн шинжилгээнд багтсан зүйлс",
  Эмэгтэй: "Эмэгтэйчүүдийн шинжилгээнд багтсан зүйлс",
  Хүүхэд: "Хүүхдийн шинжилгээнд багтсан зүйлс",
};

/** True when the parser will read this line as a list heading. */
export function isCheckupListTitle(title: string): boolean {
  const line = clean(title);
  return LIST_HEADING.test(line) && line.length <= 120;
}

function oneLine(value: string): string {
  return value.replace(/[*\\]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Writes the lists back as description text that splitHealthCheckup reads into the
 * same lists, so the website shows exactly what the admin editor showed. Values are
 * nudged only where the line format would otherwise change their meaning (a colon
 * inside a test name, a trailing full stop that would turn a test into a remark).
 */
export function composeHealthCheckup(split: CheckupSplit): string {
  const blocks: string[] = [];
  if (split.intro.trim()) blocks.push(split.intro.trim());
  for (const list of split.lists) {
    const lines: string[] = [];
    const title = oneLine(list.title).replace(/[:：]$/, "");
    lines.push(isCheckupListTitle(title) ? title : CHECKUP_LIST_TITLES[list.audience] || CHECKUP_LIST_TITLES.Шинжилгээ);
    list.groups.forEach((group, index) => {
      const items = group.items
        .map((item) => ({
          label: oneLine(item.label).replace(/[:：]/g, " –").replace(/[.!?]+$/, "").replace(/^\d+\s*[.)]\s*/, "").trim(),
          detail: oneLine(item.detail || ""),
        }))
        .filter((item) => item.label);
      if (!items.length) return;
      const notes = group.notes.map(oneLine).filter(Boolean);
      for (const note of notes) lines.push(`Жич: ${note}`);
      // An untitled group needs a break from the group above it, or its tests join that group.
      const groupTitle = oneLine(group.title).replace(/[:：]+$/, "") || (index > 0 && !notes.length ? "Бусад" : "");
      if (groupTitle) lines.push(`${groupTitle}:`);
      for (const item of items) lines.push(item.detail ? `${item.label}: ${item.detail}` : item.label);
    });
    // A heading with no tests under it would show on the website as stray text.
    if (lines.length === 1) continue;
    for (const note of list.notes.map(oneLine).filter(Boolean)) lines.push(`Жич: ${note}`);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}
