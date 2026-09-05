import { useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, Icons, cx } from "@/components/ui";
import { TabHeader } from "./AdminShared";
import type { TravelTrip } from "@/lib/adminTypes";

type CalendarTripDay = {
  key: string;
  month: number;
  day: number;
  label: string;
  trip: TravelTrip;
};

type CalendarRule = {
  rule: string;
  trip: TravelTrip;
};

const MONTH_LABELS = [
  "1 сар",
  "2 сар",
  "3 сар",
  "4 сар",
  "5 сар",
  "6 сар",
  "7 сар",
  "8 сар",
  "9 сар",
  "10 сар",
  "11 сар",
  "12 сар",
];

function tripHasPdf(trip: TravelTrip): boolean {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  return (
    (typeof extra.poster_trip_id === "string" && extra.poster_trip_id.trim().length > 0) ||
    (typeof extra.brochure_pdf_url === "string" && extra.brochure_pdf_url.startsWith("https://")) ||
    (typeof extra.source_file_attachment_id === "string" && extra.source_file_attachment_id.trim().length > 0)
  );
}

function tripPosterId(trip: TravelTrip): string {
  const posterId = (trip.extra as Record<string, unknown>)?.poster_trip_id;
  return typeof posterId === "string" ? posterId : "";
}

function parseTripCalendar(trip: TravelTrip): { days: CalendarTripDay[]; rules: CalendarRule[] } {
  const days: CalendarTripDay[] = [];
  const rules: CalendarRule[] = [];

  for (const raw of trip.departure_dates || []) {
    const text = raw.trim();
    if (!text) continue;

    let matched = false;
    const monthPattern = /(\d{1,2})\s*(?:-?р\s*)?сарын/gi;
    const monthMatches = Array.from(text.matchAll(monthPattern));

    for (let i = 0; i < monthMatches.length; i += 1) {
      const monthMatch = monthMatches[i];
      const month = Number(monthMatch[1]);
      if (month < 1 || month > 12) continue;
      const start = (monthMatch.index || 0) + monthMatch[0].length;
      const end = monthMatches[i + 1]?.index ?? text.length;
      const segment = text.slice(start, end);
      for (const dayMatch of segment.matchAll(/(?<!\d)(\d{1,2})(?:\s*-\s*(\d{1,2}))?(?!\d)/g)) {
        const first = Number(dayMatch[1]);
        const last = Number(dayMatch[2] || dayMatch[1]);
        if (first < 1 || first > 31 || last < 1 || last > 31 || first > last) continue;
        matched = true;
        for (let day = first; day <= last; day += 1) {
          days.push({
            key: `${trip.id}:${month}:${day}:${text}`,
            month,
            day,
            label: text,
            trip,
          });
        }
      }
    }

    if (!matched) {
      const slash = text.match(/(?<!\d)(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/);
      if (slash) {
        const month = Number(slash[1]);
        const day = Number(slash[2]);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          matched = true;
          days.push({ key: `${trip.id}:${month}:${day}:${text}`, month, day, label: text, trip });
        }
      }
    }

    if (!matched) rules.push({ rule: text, trip });
  }

  return { days, rules };
}

function money(value: number | null | undefined): string {
  return typeof value === "number" ? `${value.toLocaleString("mn-MN")}₮` : "Үнэ дутуу";
}

export function TripCalendarTab({
  trips,
  onEditTrip,
}: {
  trips: TravelTrip[];
  onEditTrip: (trip: TravelTrip) => void;
}) {
  const activeTrips = useMemo(
    () => trips.filter((trip) => trip.status === "active" && trip.customer_visible !== false),
    [trips],
  );
  const { days, rules, missing } = useMemo(() => {
    const parsedDays: CalendarTripDay[] = [];
    const parsedRules: CalendarRule[] = [];
    const missingTrips: TravelTrip[] = [];

    for (const trip of activeTrips) {
      const parsed = parseTripCalendar(trip);
      parsedDays.push(...parsed.days);
      parsedRules.push(...parsed.rules);
      if (parsed.days.length === 0 && parsed.rules.length === 0) missingTrips.push(trip);
    }

    parsedDays.sort((a, b) => a.month - b.month || a.day - b.day || a.trip.route_name.localeCompare(b.trip.route_name, "mn"));
    return { days: parsedDays, rules: parsedRules, missing: missingTrips };
  }, [activeTrips]);

  const monthNumbers = useMemo(() => {
    const set = new Set(days.map((item) => item.month));
    return Array.from(set).sort((a, b) => a - b);
  }, [days]);
  const [selectedMonth, setSelectedMonth] = useState<number | "all">("all");
  const [selectedKey, setSelectedKey] = useState<string>("");

  const visibleMonths = selectedMonth === "all" ? monthNumbers : monthNumbers.filter((month) => month === selectedMonth);
  const selectedItems = selectedKey ? days.filter((item) => `${item.month}-${item.day}` === selectedKey) : [];

  return (
    <div className="space-y-3">
      <TabHeader
        icon={<Icons.calendar size={20} />}
        title="Календарь"
        description="Аяллууд ямар өдөр гарахыг нэг дор харна."
        actions={
          <div className="flex flex-wrap gap-2">
            <Badge tone="success">{days.length} өдөр</Badge>
            <Badge tone={missing.length ? "warning" : "neutral"}>{missing.length} огноо дутуу</Badge>
          </div>
        }
      />

      {activeTrips.length === 0 ? (
        <Card className="p-4">
          <EmptyState icon={<Icons.calendar size={26} />} title="Идэвхтэй аялал алга" description="Эхлээд аяллаа идэвхтэй болгож харагдуулна уу." />
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-3">
            <Card className="flex flex-wrap items-center gap-2 p-3">
              <Button size="sm" variant={selectedMonth === "all" ? "primary" : "secondary"} onClick={() => setSelectedMonth("all")}>
                Бүх сар
              </Button>
              {monthNumbers.map((month) => (
                <Button key={month} size="sm" variant={selectedMonth === month ? "primary" : "secondary"} onClick={() => setSelectedMonth(month)}>
                  {MONTH_LABELS[month - 1]}
                </Button>
              ))}
            </Card>

            {visibleMonths.map((month) => {
              const monthItems = days.filter((item) => item.month === month);
              const byDay = new Map<number, CalendarTripDay[]>();
              for (const item of monthItems) {
                byDay.set(item.day, [...(byDay.get(item.day) || []), item]);
              }
              return (
                <Card key={month} className="p-3.5">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-base font-semibold text-ink">{MONTH_LABELS[month - 1]}</h3>
                    <span className="text-xs text-ink-subtle">{monthItems.length} аяллын өдөр</span>
                  </div>
                  <div className="grid grid-cols-7 gap-1.5">
                    {Array.from({ length: 31 }, (_, index) => {
                      const day = index + 1;
                      const items = byDay.get(day) || [];
                      const key = `${month}-${day}`;
                      return (
                        <button
                          key={key}
                          type="button"
                          disabled={items.length === 0}
                          onClick={() => setSelectedKey(key)}
                          className={cx(
                            "min-h-20 rounded-md border p-1.5 text-left transition-colors",
                            items.length
                              ? selectedKey === key
                                ? "border-brand bg-brand-soft"
                                : "border-line bg-surface hover:border-brand"
                              : "border-line/50 bg-surface-sunken/50 text-ink-subtle",
                          )}
                        >
                          <span className="text-xs font-semibold tabular-nums">{day}</span>
                          {items.length > 0 && (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {items.slice(0, 3).map((item) => (
                                <span key={item.key} className="h-1.5 w-1.5 rounded-full bg-brand" />
                              ))}
                              {items.length > 3 && <span className="text-[10px] font-semibold text-brand">+{items.length - 3}</span>}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </Card>
              );
            })}
          </div>

          <div className="space-y-3">
            <Card className="p-3.5">
              <h3 className="text-sm font-semibold text-ink">
                {selectedItems.length ? `${selectedItems[0].month} сарын ${selectedItems[0].day}` : "Өдөр сонгох"}
              </h3>
              <div className="mt-3 space-y-2">
                {selectedItems.length === 0 ? (
                  <p className="text-sm text-ink-subtle">Календарь дээр өдөр дарахад тухайн өдөр гарах аяллууд энд гарна.</p>
                ) : (
                  selectedItems.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => onEditTrip(item.trip)}
                      className="w-full rounded-lg border border-line bg-surface p-2.5 text-left hover:border-brand"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold text-ink">{item.trip.route_name}</p>
                        <Badge tone={tripHasPdf(item.trip) ? "success" : "danger"}>{tripHasPdf(item.trip) ? "PDF" : "PDF дутуу"}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-ink-subtle">{money(item.trip.adult_price)} · {item.trip.duration_text || "хугацаа дутуу"}</p>
                      {tripPosterId(item.trip) && <p className="mt-1 truncate text-[11px] text-brand">poster: {tripPosterId(item.trip)}</p>}
                    </button>
                  ))
                )}
              </div>
            </Card>

            {(rules.length > 0 || missing.length > 0) && (
              <Card className="p-3.5">
                <h3 className="text-sm font-semibold text-ink">Шалгах огноо</h3>
                <div className="mt-3 space-y-2">
                  {rules.slice(0, 8).map((item) => (
                    <button key={`${item.trip.id}:${item.rule}`} type="button" onClick={() => onEditTrip(item.trip)} className="w-full rounded-md border border-line bg-surface px-2.5 py-2 text-left hover:border-brand">
                      <p className="truncate text-sm font-medium text-ink">{item.trip.route_name}</p>
                      <p className="truncate text-xs text-ink-subtle">{item.rule}</p>
                    </button>
                  ))}
                  {missing.slice(0, 8).map((trip) => (
                    <button key={trip.id} type="button" onClick={() => onEditTrip(trip)} className="w-full rounded-md border border-warning/35 bg-warning-soft px-2.5 py-2 text-left hover:border-warning">
                      <p className="truncate text-sm font-medium text-ink">{trip.route_name}</p>
                      <p className="text-xs text-warning">Гарах өдөр дутуу</p>
                    </button>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
