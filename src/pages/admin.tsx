import Head from "next/head";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Icons, Logo, useToast } from "@/components/ui";
import { useAssistantChat } from "@/components/admin/useAssistantChat";
import { AdminConfirmModals } from "@/components/admin/AdminConfirmModals";
import { NewVersionBanner } from "@/components/admin/NewVersionBanner";
import { AdminLoginGate, GOOGLE_LOGIN_ERRORS } from "@/components/admin/AdminLoginGate";
import { AdminNavigation } from "@/components/admin/AdminNavigation";
import { NAV_GROUPS } from "@/components/admin/AdminSidebarItem";
import { AssistantTab } from "@/components/admin/AssistantTab";
import { AnalyticsTab } from "@/components/admin/AnalyticsTab";
import { BotTab } from "@/components/admin/BotTab";
import { CustomerDocumentsTab } from "@/components/admin/CustomerDocumentsTab";
import { FlowBuilderTab } from "@/components/admin/FlowBuilderTab";
import { GreetingTab } from "@/components/admin/GreetingTab";
import { LeadsTab } from "@/components/admin/LeadsTab";
import { PaymentsTab } from "@/components/admin/PaymentsTab";
import { ErrorLogsTab } from "@/components/admin/ErrorLogsTab";
import { SeasonsTab } from "@/components/admin/SeasonsTab";
import { SettingsTab } from "@/components/admin/SettingsTab";
import { TripsTab } from "@/components/admin/TripsTab";
import { TripCalendarTab } from "@/components/admin/TripCalendarTab";
import { TripEditModal } from "@/components/admin/TripEditModal";
import { useTripEditor } from "@/components/admin/tripEditor/useTripEditor";
import { JsonEditorTab } from "@/components/admin/JsonEditorTab";
import { TripPhotoImportTab } from "@/components/admin/TripPhotoImportTab";
import PosterTab from "@/components/admin/poster/PosterTab";
import type { ControlState, DriveSyncDiagnostics, LeadCrmStatus, LeadStats, PageControlState, PauseRow, ReadinessReport, RecentRow, SettingsForm, TabKey, TravelBotSettings, TravelLead, TravelTrip } from "@/lib/adminTypes";
import type { LeadAttentionSummary } from "@/lib/leadAttention";
import { changedSettingsFields } from "@/lib/adminPageUtils";
import { ACCEPT_FILES, ADMIN_AUTO_REFRESH_MS, SECRET_KEY, SECRET_TS_KEY, getSecretStorage, isEditableElement, settingsToForm } from "@/lib/adminPageUtils";
const TRIP_DATA_TABS = new Set<TabKey>(["assistant", "trips", "calendar", "greeting", "photos"]);
const SYSTEM_CHECK_INTERVAL_MS = 5 * 60_000;
/** Matches the leads API page (LEAD_PAGE_SIZE in /api/admin/leads). */
const LEADS_PAGE_SIZE = 200;
const TAB_KEYS = new Set<string>(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.key)));
/** The section named in the URL (#leads), so a refresh or a shared link opens the same place. */
function tabFromLocation(): TabKey | null {
  if (typeof window === "undefined") return null;
  const key = decodeURIComponent(window.location.hash.replace(/^#/, ""));
  return TAB_KEYS.has(key) ? (key as TabKey) : null;
}
export default function AdminPage() {
  const toast = useToast();
  // The session lives in an HttpOnly cookie (src/lib/adminSession.ts); the page only
  // knows whether it is signed in. Nothing loads until it is.
  const [authState, setAuthState] = useState<"checking" | "signed_in" | "signed_out">("checking");
  const authRef = useRef(authState);
  const [loginError, setLoginError] = useState("");
  const [googleSignIn, setGoogleSignIn] = useState(false);
  const [dbInfo, setDbInfo] = useState<{
    configured: boolean;
    schemaReady: boolean;
    trips: number;
    lastUpdatedAt: string | null;
  } | null>(null);
  const [driveSync, setDriveSync] = useState<DriveSyncDiagnostics | null>(null);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [systemLoaded, setSystemLoaded] = useState(false);
  // Nothing tab-specific renders before the sign-in check, so reading the URL here cannot
  // change server-rendered markup.
  const [tab, setTab] = useState<TabKey>(() => tabFromLocation() ?? "analytics");
  const tabRef = useRef<TabKey>(tab);
  // Set by the trips tab's "Постерт зураг нэмэх" button — opens that exact
  // poster once the poster tab mounts, instead of leaving them to hunt for it.
  const [posterToOpen, setPosterToOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [trips, setTrips] = useState<TravelTrip[]>([]);
  const [tripsLoaded, setTripsLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [control, setControl] = useState<ControlState | null>(null);
  const [pageControls, setPageControls] = useState<PageControlState[]>([]);
  const [pausedRows, setPausedRows] = useState<PauseRow[]>([]);
  const [recentRows, setRecentRows] = useState<RecentRow[]>([]);
  const [pauseReason, setPauseReason] = useState("");
  const [settings, setSettings] = useState<TravelBotSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState<SettingsForm | null>(null);
  const settingsBaselineRef = useRef<TravelBotSettings | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [deletingTrip, setDeletingTrip] = useState<TravelTrip | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [leads, setLeads] = useState<TravelLead[]>([]);
  const leadsRef = useRef<TravelLead[]>([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [leadsLoaded, setLeadsLoaded] = useState(false);
  const [leadQuery, setLeadQuery] = useState("");
  const leadQueryRef = useRef("");
  const [newLeadCount, setNewLeadCount] = useState(0);
  const [leadStats, setLeadStats] = useState<LeadStats | null>(null);
  const [leadAttentionSummary, setLeadAttentionSummary] = useState<LeadAttentionSummary | null>(null);
  const lastLeadActivityRef = useRef<string | null | undefined>(undefined);
  const [documentUnreviewedCount, setDocumentUnreviewedCount] = useState(0);
  const [broadcastMessage, setBroadcastMessage] = useState("");
  const [broadcastSending, setBroadcastSending] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<{ sent: number; failed: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef(search);
  const tripLoadRevision = useRef(0);
  const statusFilterRef = useRef(statusFilter);
  useEffect(() => {
    authRef.current = authState;
  }, [authState]);
  useEffect(() => {
    searchRef.current = search;
  }, [search]);
  useEffect(() => {
    statusFilterRef.current = statusFilter;
  }, [statusFilter]);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  // Same-origin requests carry the session cookie; no secret travels from this page.
  const fetchWithAdmin = useCallback(
    async (url: string, init?: RequestInit) =>
      fetch(url, { ...init, credentials: "same-origin", cache: init?.cache ?? "no-store" }),
    [],
  );
  const readJsonSafe = useCallback(async (response: Response) => {
    const raw = await response.text();
    if (!raw) return {} as Record<string, unknown>;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { error: raw.slice(0, 300) } as Record<string, unknown>;
    }
  }, []);
  const markAdminLocked = useCallback(() => {
    authRef.current = "signed_out";
    setAuthState("signed_out");
    settingsBaselineRef.current = null;
    setSettingsForm(null);
    setDbInfo(null);
    setDriveSync(null);
    setReadiness(null);
    setTrips([]);
    setTripsLoaded(false);
    setControl(null);
    setPageControls([]);
    setPausedRows([]);
    setRecentRows([]);
    setLeads([]);
    setNewLeadCount(0);
    setLeadsLoaded(false);
    setLeadStats(null);
    setDocumentUnreviewedCount(0);
  }, []);
  const loadTrips = useCallback(
    async (
      nextSearch = searchRef.current,
      nextStatusFilter = statusFilterRef.current,
      options: { showLoading?: boolean } = {},
    ) => {
      const revision = ++tripLoadRevision.current;
      if (options.showLoading) setLoading(true);
      try {
        const tripRes = await fetchWithAdmin(
          `/api/admin/trips?search=${encodeURIComponent(
            nextSearch,
          )}&status=${encodeURIComponent(nextStatusFilter)}&limit=300&view=list`,
        );
        if (tripRes.status === 401) {
          markAdminLocked();
          return;
        }
        const tripJson = await tripRes.json();
        if (revision !== tripLoadRevision.current) return;
        const nextTrips = Array.isArray(tripJson?.trips) ? tripJson.trips : [];
        setTrips(nextTrips);
        setTripsLoaded(true);
        setControl((tripJson?.control as ControlState) || null);
      } catch {
        toast.error("Аяллын мэдээлэл ачаалж чадсангүй.");
      } finally {
        if (options.showLoading && revision === tripLoadRevision.current) setLoading(false);
      }
    },
    [fetchWithAdmin, markAdminLocked, toast],
  );
  // The trip editor: its state and open / save / photo-upload handlers (tripEditor/useTripEditor.tsx).
  const tripEditor = useTripEditor({
    apiFetch: fetchWithAdmin, readJsonSafe, onLocked: markAdminLocked, trips, setBusyKey,
    onSaved: () => loadTrips(searchRef.current, statusFilterRef.current, { showLoading: true }),
  });
  const { editingTrip, isNewTrip, openingTripId, beginCreateTrip, beginEditTrip, openTripEditorForDraft, closeTripModal } = tripEditor;
  /** Every trip, unfiltered and unpaginated — for the full-catalogue export.
   *  Deliberately ignores search/status so the downloaded file is the whole
   *  catalogue regardless of what the screen is filtered to. */
  const fetchAllTrips = useCallback(async (): Promise<TravelTrip[]> => {
    const res = await fetchWithAdmin("/api/admin/trips?limit=5000");
    if (res.status === 401) {
      markAdminLocked();
      throw new Error("Нэвтрэх эрх дууссан байна.");
    }
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || "trips_fetch_failed");
    return Array.isArray(json?.trips) ? (json.trips as TravelTrip[]) : [];
  }, [fetchWithAdmin, markAdminLocked]);

  const loadPauseState = useCallback(async () => {
    try {
      const pauseRes = await fetchWithAdmin("/api/pause");
      if (pauseRes.status === 401) {
        markAdminLocked();
        return false;
      }
      const pauseJson = await pauseRes.json().catch(() => ({}));
      setControl(pauseJson?.control || null);
      setPageControls(Array.isArray(pauseJson?.pages) ? pauseJson.pages : []);
      setPausedRows(Array.isArray(pauseJson?.paused) ? pauseJson.paused : []);
      setRecentRows(Array.isArray(pauseJson?.recent) ? pauseJson.recent : []);
      return true;
    } catch {
      toast.error("Ботын төлөв ачаалж чадсангүй.");
      return false;
    }
  }, [fetchWithAdmin, markAdminLocked, toast]);
  const loadSettingsState = useCallback(async () => {
    try {
      const settingsRes = await fetchWithAdmin("/api/admin/settings");
      if (settingsRes.status === 401) {
        markAdminLocked();
        return false;
      }
      const settingsJson = await settingsRes.json().catch(() => ({}));
      if (settingsJson?.settings) {
        setSettings(settingsJson.settings as TravelBotSettings);
        // The form starts from the first load and keeps the person's edits after that; the
        // baseline records what it started from, so a save sends only real changes.
        if (!settingsBaselineRef.current) {
          settingsBaselineRef.current = settingsJson.settings as TravelBotSettings;
          setSettingsForm(settingsToForm(settingsJson.settings as TravelBotSettings));
        }
      }
      return true;
    } catch {
      toast.error("Тохиргоо ачаалж чадсангүй.");
      return false;
    }
  }, [fetchWithAdmin, markAdminLocked, toast]);
  /**
   * One page of leads. A search covers every lead on the server; append loads the next page.
   * A background refresh leaves a list the user has paged through alone.
   */
  const loadLeadsState = useCallback(async (options: { showLoading?: boolean; append?: boolean; background?: boolean } = {}) => {
    if (options.background && leadsRef.current.length > LEADS_PAGE_SIZE) return true;
    if (options.showLoading) setLoading(true);
    try {
      const query = leadQueryRef.current.trim();
      const offset = options.append ? leadsRef.current.length : 0;
      const params = new URLSearchParams({ stats: "1", offset: String(offset) });
      if (query) params.set("q", query);
      const leadsRes = await fetchWithAdmin(`/api/admin/leads?${params.toString()}`);
      if (leadsRes.status === 401) {
        markAdminLocked();
        return false;
      }
      const leadsJson = await leadsRes.json().catch(() => ({}));
      if (!leadsRes.ok) throw new Error("leads_failed");
      // A newer search has started meanwhile: its answer, not this one, fills the list.
      if (query !== leadQueryRef.current.trim()) return true;
      const page: TravelLead[] = Array.isArray(leadsJson?.leads) ? leadsJson.leads : [];
      setLeads((previous) => (options.append ? [...previous, ...page.filter((lead) => !previous.some((item) => item.id === lead.id))] : page));
      setLeadsTotal(typeof leadsJson?.total === "number" ? leadsJson.total : page.length);
      setLeadsLoaded(true);
      setNewLeadCount(
        typeof leadsJson?.new_count === "number" ? leadsJson.new_count : 0,
      );
      setLeadStats(
        leadsJson?.stats && typeof leadsJson.stats === "object"
          ? (leadsJson.stats as LeadStats)
          : null,
      );
      if (leadsJson?.attention && typeof leadsJson.attention === "object") {
        setLeadAttentionSummary(leadsJson.attention as LeadAttentionSummary);
      }
      return true;
    } catch {
      toast.error("Хүсэлтүүд ачаалж чадсангүй.");
      return false;
    } finally {
      if (options.showLoading) setLoading(false);
    }
  }, [fetchWithAdmin, markAdminLocked, toast]);
  const loadDocumentStats = useCallback(async () => {
    try {
      const res = await fetchWithAdmin("/api/admin/customer-documents?stats=1");
      if (res.status === 401) {
        markAdminLocked();
        return false;
      }
      const json = await res.json().catch(() => ({}));
      setDocumentUnreviewedCount(Number(json?.stats?.unreviewed_count || 0));
      return true;
    } catch {
      return false;
    }
  }, [fetchWithAdmin, markAdminLocked]);
  const lastSystemCheckRef = useRef(0);
  const loadAll = useCallback(async () => {
    if (authRef.current !== "signed_in") return;
    setLoading(true);
    try {
      // The data loads do not depend on the system check, which can take 10 s+
      // on a cold server; starting them first keeps it from delaying the trips.
      // The full catalogue includes rich itinerary and website-editing data.
      // Loading it on every dashboard visit made the lightweight overview wait
      // behind a large cross-database request even though that tab never reads
      // a trip row. Fetch it only for screens that actually render trip data.
      // The lead list likewise only feeds the Leads tab; the nav badge has its own poll.
      const tripLoads = TRIP_DATA_TABS.has(tabRef.current)
        ? [loadTrips(searchRef.current, statusFilterRef.current)]
        : [];
      const dataLoads = Promise.all([
        ...tripLoads,
        loadPauseState(),
        loadSettingsState(),
        ...(tabRef.current === "leads" ? [loadLeadsState({ background: true })] : []),
        loadDocumentStats(),
      ]);
      dataLoads.catch(() => undefined);
      // The readiness check reads several systems; every few minutes is enough for its banner.
      if (Date.now() - lastSystemCheckRef.current >= SYSTEM_CHECK_INTERVAL_MS) {
        const systemRes = await fetchWithAdmin("/api/admin/system");
        if (systemRes.status === 401) {
          markAdminLocked();
          return;
        }
        const systemJson = await systemRes.json();
        if (!systemJson?.authorized) {
          markAdminLocked();
          return;
        }
        lastSystemCheckRef.current = Date.now();
        setDbInfo(systemJson?.db || null);
        setDriveSync((systemJson?.drive_sync as DriveSyncDiagnostics) || null);
        setReadiness((systemJson?.readiness as ReadinessReport) || null);
        setSystemLoaded(true);
      }
      await dataLoads;
    } catch {
      toast.error("Системийн өгөгдөл ачаалж чадсангүй.");
    } finally {
      setLoading(false);
    }
  }, [
    fetchWithAdmin,
    loadDocumentStats,
    loadLeadsState,
    loadPauseState,
    loadSettingsState,
    loadTrips,
    markAdminLocked,
    toast,
  ]);
  // The AI туслах conversation: send / answer / save / undo, files and photos, the thread kept
  // across a reload (components/admin/useAssistantChat.ts).
  const assistant = useAssistantChat({ fetchWithAdmin, readJsonSafe, toast, loadAll, busyKey, setBusyKey, trips });
  const { aiInput, setAiInput, attachedFiles, dragOver, inputRef } = assistant;
  const syncDriveNow = useCallback(async () => {
    setBusyKey("drive-sync");
    try {
      const res = await fetchWithAdmin("/api/admin/drive-sync", {
        method: "POST",
      });
      const json = (await readJsonSafe(res)) as {
        diagnostics?: DriveSyncDiagnostics;
        summary?: string;
      };
      if (json.diagnostics) setDriveSync(json.diagnostics);
      if (!res.ok) {
        throw new Error(json.summary || "Google Drive синк хийх үед алдаа гарлаа.");
      }
      toast.success(json.summary || "Google Drive синк дууслаа.");
      await loadAll();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Google Drive синк хийх үед алдаа гарлаа.",
      );
    } finally {
      setBusyKey("");
    }
  }, [fetchWithAdmin, loadAll, readJsonSafe, toast]);
  // Sign-in check on load (Google is the only way in). A browser from before sessions may
  // still hold the old admin password in localStorage: it is forgotten, never sent.
  // TODO(2026-12): drop these two removeItem calls one release after Google-only sign-in.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const storage = getSecretStorage();
      storage?.removeItem(SECRET_KEY);
      storage?.removeItem(SECRET_TS_KEY);
      const res = await fetch("/api/admin/session", { cache: "no-store" }).catch(() => null);
      const json = res?.ok ? await res.json().catch(() => null) as { authorized?: boolean; google_sign_in?: boolean } | null : null;
      if (cancelled) return;
      // A refused Google sign-in comes back as ?login_error=<code>; show it once, drop it from the URL.
      const url = new URL(window.location.href);
      const googleError = url.searchParams.get("login_error");
      if (googleError) {
        setLoginError(GOOGLE_LOGIN_ERRORS[googleError] || "Нэвтэрч чадсангүй. Дахин оролдоно уу.");
        url.searchParams.delete("login_error");
        window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      }
      // No answer at all: whether Google is set up is unknown, so keep the button and say why,
      // rather than claiming sign-in is not set up.
      setGoogleSignIn(json ? Boolean(json.google_sign_in) : true);
      if (!json && !googleError) setLoginError("Сервертэй холбогдож чадсангүй. Интернэтээ шалгаад хуудсаа дахин ачаална уу.");
      const next = json?.authorized ? "signed_in" : "signed_out";
      authRef.current = next;
      setAuthState(next);
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (authState === "signed_in") void loadAll();
  }, [authState, loadAll]);
  useEffect(() => {
    leadsRef.current = leads;
  }, [leads]);
  // The lead list is fetched for the Leads tab only (loadAll skips it elsewhere); a search
  // waits for a pause in typing.
  useEffect(() => {
    leadQueryRef.current = leadQuery;
    if (tab !== "leads" || authState !== "signed_in") return;
    const timer = window.setTimeout(() => void loadLeadsState({ showLoading: true }), leadQuery.trim() ? 400 : 0);
    return () => window.clearTimeout(timer);
  }, [authState, leadQuery, loadLeadsState, tab]);
  // Back/Forward between sections, and links that name one.
  useEffect(() => {
    const syncFromUrl = () => {
      const next = tabFromLocation();
      if (next) {
        setTab(next);
        setMobileNavOpen(false);
      }
    };
    window.addEventListener("hashchange", syncFromUrl);
    return () => window.removeEventListener("hashchange", syncFromUrl);
  }, []);
  useEffect(() => {
    if (!TRIP_DATA_TABS.has(tab)) return;
    if (authState !== "signed_in") return;
    const timer = window.setTimeout(() => {
      void loadTrips(search, statusFilter, { showLoading: true });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [authState, loadTrips, search, statusFilter, tab]);
  useEffect(() => {
    if (ADMIN_AUTO_REFRESH_MS <= 0) return;
    const refresh = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (authRef.current !== "signed_in") return;
      if (typeof document !== "undefined" && isEditableElement(document.activeElement)) {
        return;
      }
      if (
        isNewTrip ||
        editingTrip != null ||
        deletingTrip ||
        confirmClear ||
        busyKey ||
        aiInput.trim() ||
        attachedFiles.length > 0 ||
        dragOver
      ) {
        return;
      }
      void loadAll();
    }, ADMIN_AUTO_REFRESH_MS);
    return () => clearInterval(refresh);
  }, [
    aiInput,
    attachedFiles.length,
    busyKey,
    confirmClear,
    deletingTrip,
    dragOver,
    editingTrip,
    isNewTrip,
    loadAll,
  ]);
  // Bot state drives the header badges everywhere and the live list on the bot tab:
  // every 5 s there, every 20 s elsewhere (each poll is a database read).
  useEffect(() => {
    const PAUSE_POLL_MS = tab === "bot" ? 5_000 : 20_000;
    const poll = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (authRef.current !== "signed_in") return;
      void loadPauseState();
    }, PAUSE_POLL_MS);
    return () => clearInterval(poll);
  }, [loadPauseState, tab]);
  // Leads that need a person (leadAttention.ts), checked every 20 s even while this browser tab
  // is in the background. New activity raises a browser notification (when staff allowed it)
  // and a toast. Only an open dashboard is alerted: nothing is sent anywhere else from here.
  useEffect(() => {
    const LEAD_POLL_MS = 20_000;
    let stopped = false;
    const check = async () => {
      if (stopped || authRef.current !== "signed_in") return;
      try {
        const res = await fetchWithAdmin("/api/admin/leads?summary=1");
        if (!res.ok) return;
        const json = await res.json().catch(() => null) as { attention?: LeadAttentionSummary } | null;
        const summary = json?.attention;
        if (!summary || stopped) return;
        setLeadAttentionSummary(summary);
        const previous = lastLeadActivityRef.current;
        lastLeadActivityRef.current = summary.latestActivityAt;
        const isNewActivity = previous !== undefined && summary.latestActivityAt !== null
          && (previous === null || summary.latestActivityAt > previous);
        if (!isNewActivity || summary.needsAttention === 0) return;
        const message = summary.waiting > 0
          ? `${summary.waiting} хэрэглэгч хариу хүлээж байна`
          : `${summary.needsAttention} хүсэлт анхаарал хүлээж байна`;
        toast.info(message);
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("Уудам — шинэ хүсэлт", { body: message, tag: "uudam-leads" });
        }
        if (tabRef.current === "leads") void loadLeadsState({ background: true });
      } catch { /* the next check retries */ }
    };
    void check();
    const poll = setInterval(() => void check(), LEAD_POLL_MS);
    return () => { stopped = true; clearInterval(poll); };
  }, [authState, fetchWithAdmin, loadLeadsState, toast]);
  const pausedIds = useMemo(
    () => new Set(pausedRows.map((row) => row.sender_id)),
    [pausedRows],
  );
  const handoffRows = useMemo(
    () => pausedRows.filter((row) => row.reason === "handoff"),
    [pausedRows],
  );
  async function signOut() {
    await fetch("/api/admin/session", { method: "DELETE" }).catch(() => null);
    setMobileNavOpen(false);
    markAdminLocked();
  }
  async function runPauseAction(
    action:
      | "pause"
      | "resume"
      | "global_pause"
      | "global_resume"
      | "page_pause"
      | "page_resume"
      | "photo_only_enable"
      | "photo_only_disable",
    senderId?: string,
    durationMs?: number | null,
    pageId?: string,
  ) {
    setBusyKey(`${action}:${pageId || senderId || "global"}`);
    try {
      const body: Record<string, unknown> = { action };
      if (senderId) body.sender_id = senderId;
      if (pageId) body.page_id = pageId;
      if (durationMs != null) body.duration_ms = durationMs;
      if (action === "global_pause" || action === "page_pause")
        body.reason = pauseReason || null;
      const res = await fetchWithAdmin("/api/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || "Үйлдэл амжилтгүй.");
      }
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Үйлдэл амжилтгүй.");
    } finally {
      setBusyKey("");
    }
  }
  async function confirmDeleteTrip() {
    if (!deletingTrip) return;
    setBusyKey(`delete-trip-${deletingTrip.id}`);
    const trip = deletingTrip;
    setDeletingTrip(null);
    try {
      const res = await fetchWithAdmin(
        `/api/admin/trips?id=${encodeURIComponent(trip.id)}`,
        { method: "DELETE" },
      );
      const json = await readJsonSafe(res);
      if (!res.ok) throw new Error(String(json?.error || "Устгаж чадсангүй."));
      toast.success(`"${trip.route_name || trip.operator_name}" архивлагдлаа.`);
      await loadTrips(searchRef.current, statusFilterRef.current, {
        showLoading: true,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Устгаж чадсангүй.");
    } finally {
      setBusyKey("");
    }
  }
  /**
   * Hides or shows one trip. Only the flag travels, with the version on screen:
   * the trips API merges extra key by key, and a stale copy of the whole extra
   * (the old behaviour) reverted any price or itinerary saved in the meantime.
   */
  async function toggleTripVisibility(trip: TravelTrip) {
    if (busyKey) return;
    const show = (trip.extra as Record<string, unknown> | undefined)?.customer_visible === false;
    setBusyKey(`visibility-${trip.id}`);
    try {
      const res = await fetchWithAdmin("/api/admin/trips", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: trip.id, fields: { extra: { customer_visible: show } }, expectedUpdatedAt: trip.updated_at }),
      });
      const json = await readJsonSafe(res);
      if (!res.ok) {
        throw new Error(res.status === 409
          ? "Энэ аяллыг өөр газраас дөнгөж шинэчилсэн байна. Жагсаалт шинэчлэгдлээ, дахин оролдоно уу."
          : String(json?.message || json?.error || "Өөрчилж чадсангүй."));
      }
      toast.success(show
        ? "Аялал дахин харагдана. Бот энэ талаар хариулна."
        : "Аялал нуугдлаа. Бот энэ аяллын талаар асуухад мэдэхгүй мэт хариулна.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Өөрчилж чадсангүй.");
    } finally {
      setBusyKey("");
      void loadTrips(searchRef.current, statusFilterRef.current, { showLoading: false });
    }
  }
  /** Archives exactly the trips the confirmation dialog listed. Resolves true when all were archived. */
  async function archiveManyTrips(ids: string[]): Promise<boolean> {
    try {
      const res = await fetchWithAdmin("/api/admin/trips", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const json = await readJsonSafe(res) as { archived?: string[]; failed?: string[]; error?: string; message?: string };
      if (!res.ok && res.status !== 207) throw new Error(json.message || json.error || "Архивлаж чадсангүй.");
      const archived = json.archived?.length ?? 0;
      const failed = json.failed?.length ?? 0;
      if (failed > 0) toast.error(`${archived} аялал архивлагдлаа, ${failed} нь амжилтгүй. Дахин оролдоно уу.`);
      else toast.success(`${archived} аялал архивлагдлаа.`);
      return failed === 0;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Архивлаж чадсангүй.");
      return false;
    } finally {
      void loadTrips(searchRef.current, statusFilterRef.current, { showLoading: true });
    }
  }
  /**
   * Shortcut from a trip card/poster to the AI туслах tab: names the trip in
   * the instruction box so staff don't have to retype/search for it, and
   * leaves sending to them — the assistant's own propose → review → confirm
   * flow is the save path, this only gets them to a pre-filled box faster.
   */
  function askAiAboutTrip(tripName: string) {
    setAiInput(`"${tripName}" аяллыг `);
    selectAdminTab("assistant");
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }
  async function sendBroadcast() {
    if (!broadcastMessage.trim() || broadcastSending) return;
    setBroadcastSending(true);
    setBroadcastResult(null);
    try {
      const res = await fetchWithAdmin("/api/admin/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: broadcastMessage.trim(), platform: "facebook" }),
      });
      const json = await res.json();
      if (res.ok && json.ok) {
        setBroadcastResult({ sent: json.sent ?? 0, failed: json.failed ?? 0 });
        setBroadcastMessage("");
        toast.success(`Broadcast: ${json.sent} илгээсэн, ${json.failed} алдаа.`);
      } else {
        toast.error(json.message || `Алдаа: ${json.error || "server_error"}`);
      }
    } catch {
      toast.error("Broadcast илгээж чадсангүй.");
    } finally {
      setBroadcastSending(false);
    }
  }
  async function markLeadSeen(lead: TravelLead) {
    setLeads((prev) =>
      prev.map((item) =>
        item.id === lead.id ? { ...item, status: "seen" } : item,
      ),
    );
    setNewLeadCount((count) => Math.max(0, count - 1));
    try {
      const res = await fetchWithAdmin("/api/admin/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      toast.error("Тэмдэглэж чадсангүй. Дахин оролдоно уу.");
      await loadLeadsState({ showLoading: true });
    }
  }
  async function updateLeadCrmStatus(lead: TravelLead, newStatus: LeadCrmStatus) {
    setLeads((prev) =>
      prev.map((item) =>
        item.id === lead.id
          ? { ...item, lead_status: newStatus, status: "seen" }
          : item,
      ),
    );
    setNewLeadCount((count) =>
      lead.status === "new" ? Math.max(0, count - 1) : count,
    );
    try {
      const res = await fetchWithAdmin("/api/admin/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, lead_status: newStatus }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      toast.error("Статус шинэчилж чадсангүй.");
      await loadLeadsState({ showLoading: true });
    }
  }
  // A consultant takes the conversation (the bot stops for this customer) or hands it back.
  async function setLeadBotPaused(lead: TravelLead, paused: boolean) {
    setLeads((prev) => prev.map((item) => item.sender_id === lead.sender_id
      ? { ...item, bot_paused: paused, bot_pause_reason: paused ? "manual" : "" } : item));
    try {
      const res = await fetchWithAdmin("/api/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: paused ? "pause" : "resume", sender_id: lead.sender_id }),
      });
      if (!res.ok) throw new Error("failed");
      toast.success(paused ? "Бот энэ хэрэглэгчид хариулахгүй — та хариулна." : "Харилцааг ботод буцаалаа.");
    } catch {
      toast.error("Ботын төлөвийг өөрчилж чадсангүй.");
      await loadLeadsState({ showLoading: true });
    }
  }
  async function assignLead(lead: TravelLead, assignee: string) {
    setLeads((prev) => prev.map((item) => item.id === lead.id ? { ...item, assigned_to: assignee, status: "seen" } : item));
    try {
      const res = await fetchWithAdmin("/api/admin/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, assigned_to: assignee }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      toast.error("Хариуцагч хадгалж чадсангүй.");
      await loadLeadsState({ showLoading: true });
    }
  }
  /** Saves only what this person changed since the form was loaded (changedSettingsFields). */
  async function saveSettings() {
    if (!settingsForm) return;
    const changed = changedSettingsFields(settingsBaselineRef.current, settingsForm);
    if (Object.keys(changed).length === 0) {
      toast.success("Өөрчлөлт ороогүй байна.");
      return;
    }
    setBusyKey("save-settings");
    try {
      const res = await fetchWithAdmin("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: changed }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Тохиргоо хадгалж чадсангүй.");
      if (json?.settings) {
        settingsBaselineRef.current = json.settings as TravelBotSettings;
        setSettings(json.settings as TravelBotSettings);
        setSettingsForm(settingsToForm(json.settings as TravelBotSettings));
      }
      toast.success("Тохиргоо хадгалагдлаа.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Хадгалж чадсангүй.");
    } finally {
      setBusyKey("");
    }
  }
  const pausedPageCount = pageControls.filter((page) => page.bot_paused).length;
  const botPaused = pausedPageCount > 0;
  const headerTripCount = tripsLoaded ? trips.length : dbInfo?.trips ?? 0;
  // Live = what customers can see on the website; drafts are not published.
  const liveTripCount = trips.filter((trip) => ["active", "sold_out", "paused"].includes(trip.status)).length;
  const draftTripCount = trips.filter((trip) => trip.status === "draft").length;
  const headerTripSummary =
    tripsLoaded && statusFilter === ""
      ? `${liveTripCount} идэвхтэй${draftTripCount > 0 ? ` · ${draftTripCount} ноорог` : ""}`
      : `${headerTripCount} аялал`;
  const headerTripLabel = tripsLoaded || dbInfo ? headerTripSummary : "Аялал ачаалж байна";
  const navBadges: Partial<Record<TabKey, number>> = {
    bot: handoffRows.length || undefined,
    // Leads that need a person now, not every unread lead ever (172 on 2026-10-30).
    leads: (leadAttentionSummary ? leadAttentionSummary.needsAttention : newLeadCount) || undefined,
    documents: documentUnreviewedCount || undefined,
  };
  const currentSection = NAV_GROUPS.flatMap((group) => group.items).find((item) => item.key === tab);
  /** Opens a section and records it in the URL (#trips), so refresh and Back keep the place. */
  function selectAdminTab(nextTab: TabKey) {
    setTab(nextTab);
    setMobileNavOpen(false);
    if (typeof window !== "undefined" && window.location.hash !== `#${nextTab}`) {
      window.location.hash = nextTab;
    }
  }
  if (authState !== "signed_in") {
    return (
      <AdminLoginGate
        checking={authState === "checking"}
        googleSignIn={googleSignIn}
        error={loginError}
      />
    );
  }
  return (
    <div className="flex h-dvh overflow-hidden">
      <Head>
        <title>{`${leadAttentionSummary?.needsAttention ? `(${leadAttentionSummary.needsAttention}) ` : ""}${currentSection?.label ?? ""} · Аяллын удирдлага`}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <a href="#admin-content" className="sr-only z-50 rounded-md bg-brand px-4 py-3 text-sm font-semibold text-white focus:not-sr-only focus:fixed focus:left-3 focus:top-2">
        Үндсэн хэсэгт очих
      </a>
      <AdminNavigation
        tab={tab}
        badges={navBadges}
        mobileOpen={mobileNavOpen}
        desktopHidden={sidebarHidden}
        onClose={() => setMobileNavOpen(false)}
        onSelect={selectAdminTab}
        onSignOut={() => void signOut()}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Top bar */}
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-label="Цэс нээх"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink md:hidden"
          >
            <Icons.menu size={20} />
          </button>
          <button
            type="button"
            aria-label={sidebarHidden ? "Цэс харуулах" : "Цэс хураах"}
            aria-controls="admin-navigation"
            aria-expanded={!sidebarHidden}
            onClick={() => setSidebarHidden((hidden) => !hidden)}
            className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink md:flex"
          >
            <Icons.menu size={20} />
          </button>
          <Logo className="min-w-0 md:hidden" />
          <div className="hidden min-w-0 items-center gap-2 text-sm md:flex">
            <span className="text-ink-subtle">Удирдлага</span>
            <span aria-hidden="true" className="text-line-strong">/</span>
            <span className="truncate font-semibold text-ink">{currentSection?.label}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {handoffRows.length > 0 && (
            <button type="button" aria-label={`${handoffRows.length} хэрэглэгч зөвлөх хүлээж байна. Ботын хяналт нээх`} onClick={() => selectAdminTab("bot")} className="rounded-full transition-opacity hover:opacity-80">
              <Badge tone="warning" dot>
                <Icons.user size={13} /> {handoffRows.length}
              </Badge>
            </button>
          )}
          <Badge tone={!control ? "neutral" : botPaused ? "warning" : "success"} dot className="whitespace-nowrap">
            {!control ? "Ботын төлөв шалгаж байна" : botPaused ? `${pausedPageCount} хуудас зогссон` : "Бот идэвхтэй"}
          </Badge>
          <span className="hidden sm:inline-flex">
            <Badge
              tone={systemLoaded && !dbInfo?.configured ? "danger" : "neutral"}
              className="tabular-nums"
            >
              {headerTripLabel}
            </Badge>
          </span>
        </div>
      </header>
        {/* Content */}
        <main id="admin-content" tabIndex={-1} className="scroll-area min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="mx-auto w-full max-w-6xl">
          {botPaused && (
            <div className="mb-4 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2">
                  <Icons.pause size={16} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">Ботын хуудас зогссон байна.</p>
                    <p className="mt-0.5 text-danger/80">
                      Зогсоосон хуудсанд бот хариу илгээхгүй. Хэрэглэгчтэй ажилтан үргэлжлүүлэн харилцана.
                    </p>
                  </div>
                </div>
                <Button size="sm" variant="secondary" onClick={() => selectAdminTab("bot")}>
                  Ботын хяналт нээх
                </Button>
              </div>
            </div>
          )}
          {systemLoaded && !dbInfo?.configured && (
            <div className="mb-4">
              <Alert tone="danger">
                Өгөгдлийн сан холбогдоогүй байна. Мэдээлэл хадгалагдахгүй.
              </Alert>
            </div>
          )}
          {readiness && readiness.issues.length > 0 && (
            <details className="mb-4 border-b border-line pb-3" open={readiness.issues.some((issue) => issue.severity === "critical")}>
              <summary className="cursor-pointer text-sm font-medium text-ink-muted">Системийн шалгалт: {readiness.score}/10 · {readiness.issues.length} анхааруулга</summary>
              <Alert
                tone={
                  readiness.issues.some((issue) => issue.severity === "critical")
                    ? "danger"
                    : "warning"
                }
              >
                Бэлэн байдлын оноо {readiness.score}/10.{" "}
                {readiness.issues
                  .slice(0, 3)
                  .map((issue) => issue.message)
                  .join(" ")}
              </Alert>
            </details>
          )}
          <div key={tab} className="animate-fade-up">
          {tab === "assistant" && (
            <AssistantTab
              messages={assistant.messages}
              existingTrips={trips}
              tripDetails={assistant.tripDetails}
              aiInput={aiInput}
              setAiInput={setAiInput}
              attachedFiles={attachedFiles}
              onRemoveAttachedFile={assistant.removeAttachedFile}
              dragOver={dragOver}
              setDragOver={assistant.setDragOver}
              busy={busyKey === "ai-send"}
              busyLabel={assistant.busyLabel}
              busyProgress={assistant.busyProgress}
              busyStages={assistant.busyStages}
              applyBusyId={
                busyKey.startsWith("apply-")
                  ? busyKey.slice(6)
                  : busyKey.startsWith("rollback-")
                    ? busyKey.slice(9)
                    : ""
              }
              clarifyBusyId={
                busyKey.startsWith("clarify-") ? busyKey.slice(8) : ""
              }
              onSend={() => void assistant.sendAssistant()}
              onChooseOption={assistant.chooseAskOption}
              onQuickAction={(kind, trip, value) => void assistant.sendQuickAction(kind, trip, value)}
              onEditTripPrice={(trip) => beginEditTrip(trip)}
              onNewTrip={() => beginCreateTrip()}
              onEditDraftTrip={openTripEditorForDraft}
              onApply={(message) => void assistant.applyProposal(message)}
              onRollback={(message) => void assistant.rollbackProposal(message)}
              onSubmitClarificationForm={(message, answers) =>
                void assistant.submitClarificationForm(message, answers)
              }
              onCancelProposal={(id) =>
                assistant.setProposalMessage(id, { status: "cancelled" })
              }
              onResendInstruction={assistant.resendInstruction}
              onNewConversation={assistant.newConversation}
              onPickFile={() => fileInputRef.current?.click()}
              onDropFiles={(files) => void assistant.attachFiles(files)}
              chatEndRef={assistant.chatEndRef}
              inputRef={inputRef}
            />
          )}
          {tab === "trips" && (
            <TripsTab
              apiFetch={fetchWithAdmin}
              trips={trips}
              search={search}
              setSearch={setSearch}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              loading={loading}
              onRefresh={() =>
                void loadTrips(searchRef.current, statusFilterRef.current, {
                  showLoading: true,
                })
              }
              onCreate={beginCreateTrip}
              onEdit={beginEditTrip}
              onDelete={(trip) => setDeletingTrip(trip)}
              onFetchAllTrips={fetchAllTrips}
              onFixPhotosOnPoster={(posterId) => {
                setPosterToOpen(posterId);
                selectAdminTab("poster");
              }}
              onAskAi={askAiAboutTrip}
              businessName={settings?.business_name || ""}
              visibilityBusyId={busyKey.startsWith("visibility-") ? busyKey.slice(11) : ""}
              openingTripId={openingTripId}
              loaded={tripsLoaded}
              onToggleVisible={(trip) => void toggleTripVisibility(trip)}
              onArchiveMany={archiveManyTrips}
            />
          )}
          {tab === "calendar" && (
            <TripCalendarTab trips={trips} onEditTrip={beginEditTrip} />
          )}
          {tab === "bot" && (
            <BotTab
              control={control}
              settings={settings}
              pageControls={pageControls}
              pauseReason={pauseReason}
              setPauseReason={setPauseReason}
              recentRows={recentRows}
              pausedRows={pausedRows}
              pausedIds={pausedIds}
              busyKey={busyKey}
              apiFetch={fetchWithAdmin}
              onPauseAction={(action, senderId, ms, pageId) =>
                void runPauseAction(action, senderId, ms, pageId)
              }
              onSettingsChanged={() => void loadSettingsState()}
              onConversationsChanged={() => void loadPauseState()}
            />
          )}
          {tab === "leads" && (
            <LeadsTab
              leads={leads}
              total={leadsTotal}
              loaded={leadsLoaded}
              stats={leadStats}
              attention={leadAttentionSummary}
              loading={loading}
              query={leadQuery}
              onQueryChange={setLeadQuery}
              onLoadMore={() => void loadLeadsState({ showLoading: true, append: true })}
              onRefresh={() => void loadLeadsState({ showLoading: true })}
              onMarkSeen={(lead) => void markLeadSeen(lead)}
              onUpdateStatus={(lead, status) => void updateLeadCrmStatus(lead, status)}
              onAssign={(lead, assignee) => void assignLead(lead, assignee)}
              onSetBotPaused={(lead, paused) => void setLeadBotPaused(lead, paused)}
              broadcastMessage={broadcastMessage}
              broadcastSending={broadcastSending}
              broadcastResult={broadcastResult}
              onBroadcastChange={setBroadcastMessage}
              onBroadcastSend={() => void sendBroadcast()}
            />
          )}
          {tab === "documents" && (
            <CustomerDocumentsTab
              apiFetch={fetchWithAdmin}
              onChanged={() => void loadDocumentStats()}
            />
          )}
          {tab === "settings" && settingsForm && (
            <SettingsTab
              form={settingsForm}
              setForm={setSettingsForm}
              updatedAt={settings?.updated_at}
              busy={busyKey === "save-settings"}
              driveSync={driveSync}
              syncBusy={busyKey === "drive-sync"}
              onSyncDriveNow={() => void syncDriveNow()}
              onSave={() => void saveSettings()}
              onRequestClear={() => setConfirmClear(true)}
            />
          )}
          {tab === "analytics" && (
            <AnalyticsTab apiFetch={fetchWithAdmin} onNavigate={selectAdminTab} onUnauthorized={markAdminLocked} />
          )}
          {tab === "flow" && (
            <FlowBuilderTab
              extra={(settings?.extra ?? {}) as Record<string, unknown>}
              apiFetch={fetchWithAdmin}
              onSaved={loadAll}
            />
          )}
          {tab === "payments" && <PaymentsTab apiFetch={fetchWithAdmin} />}
          {tab === "errors" && <ErrorLogsTab apiFetch={fetchWithAdmin} />}
          {tab === "greeting" && (
            <GreetingTab
              extra={(settings?.extra ?? {}) as Record<string, unknown>}
              apiFetch={fetchWithAdmin}
              onSaved={loadAll}
              autoPhotos={trips
                .filter((t) => t.status === "active" && t.photo_urls?.length)
                .map((t) => t.photo_urls[0])
                .slice(0, 10)}
            />
          )}
          {tab === "seasons" && (
            <SeasonsTab
              extra={(settings?.extra ?? {}) as Record<string, unknown>}
              apiFetch={fetchWithAdmin}
              onSaved={loadAll}
            />
          )}
          {tab === "photos" && (
            <TripPhotoImportTab
              trips={trips}
              apiFetch={fetchWithAdmin}
              onComplete={() => void loadTrips(searchRef.current, statusFilterRef.current, { showLoading: true })}
            />
          )}
          {tab === "poster" && (
            <PosterTab
              apiFetch={fetchWithAdmin}
              openPosterId={posterToOpen}
              onPosterOpened={() => setPosterToOpen(null)}
              onAskAi={askAiAboutTrip}
            />
          )}
          {tab === "json" && (
            <JsonEditorTab
              apiFetch={fetchWithAdmin}
              onSaved={loadAll}
            />
          )}
          </div>
          </div>
        </main>
      </div>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_FILES}
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          if (files?.length) void assistant.attachFiles(files);
          e.target.value = "";
        }}
      />
      {/* Trip edit / create modal */}
      <TripEditModal
        {...tripEditor.modalProps}
        busyKey={busyKey}
        apiFetch={fetchWithAdmin}
        onAskAi={(tripName) => {
          closeTripModal();
          askAiAboutTrip(tripName);
        }}
      />
      <NewVersionBanner />
      <AdminConfirmModals
        deletingTrip={deletingTrip}
        deleteBusy={busyKey.startsWith("delete-trip-")}
        confirmClear={confirmClear}
        onCloseDelete={() => setDeletingTrip(null)}
        onConfirmDelete={() => void confirmDeleteTrip()}
        onCloseClear={() => setConfirmClear(false)}
        onConfirmClear={() => {
          setConfirmClear(false);
          setSettingsForm((prev) =>
            prev
              ? {
                  ...prev,
                  quick_info_reply: "",
                  quick_info_keywords: "",
                  comment_trigger_patterns: "",
                  comment_public_reply: "",
                  comment_dm_reply: "",
                  faq: [],
                  special_offers: [],
                  discount_policies: [],
                  verified_credentials: [],
                }
              : prev,
          );
        }}
      />
      {tripEditor.photoReplaceModal}
    </div>
  );
}
