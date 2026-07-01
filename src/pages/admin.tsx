import Head from "next/head";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Icons, Input, Modal, Select, Spinner, Textarea, cx, useToast } from "@/components/ui";
import { extractGoogleDriveFileIds } from "@/lib/googleDriveLinks";
import { buildProposalClarifications, compactWarnings } from "@/lib/adminProposalUtils";
import { AdminConfirmModals } from "@/components/admin/AdminConfirmModals";
import { AdminLoginGate } from "@/components/admin/AdminLoginGate";
import { AdminSidebarItem } from "@/components/admin/AdminSidebarItem";
import { AssistantTab } from "@/components/admin/AssistantTab";
import { AnalyticsTab } from "@/components/admin/AnalyticsTab";
import { BotTab } from "@/components/admin/BotTab";
import { FlowBuilderTab } from "@/components/admin/FlowBuilderTab";
import { GreetingTab } from "@/components/admin/GreetingTab";
import { LeadsTab } from "@/components/admin/LeadsTab";
import { PaymentsTab } from "@/components/admin/PaymentsTab";
import { SeasonsTab } from "@/components/admin/SeasonsTab";
import { SettingsTab } from "@/components/admin/SettingsTab";
import { TripsTab } from "@/components/admin/TripsTab";
import { TripEditModal } from "@/components/admin/TripEditModal";
import { JsonEditorTab } from "@/components/admin/JsonEditorTab";
import { TripPhotoImportTab } from "@/components/admin/TripPhotoImportTab";
import PosterTab from "@/components/admin/poster/PosterTab";
import { MAX_PHOTOS_PER_TRIP } from "@/lib/tripPhotoImport/types";
import type { AIAction, AIProposal, AIProposalResponse, AttachedFile, ChatButton, ChatMessage, ClarificationAnswer, ClarificationQuestion, AdminMsg, ChildRule, ConflictItem, ConflictSeverity, ControlState, DiscountGroup, DriveSyncDiagnostics, DriveSyncRecentFile, ExtraFee, FlowRule, LeadCrmStatus, LeadStats, NoteMsg, PageControlState, ParseUploadUnit, PauseRow, PriceGroup, ProposalMsg, ReadinessReport, RecentRow, RoomPrice, SettingsForm, StructuredRow, TabKey, TravelBotSettings, TravelLead, TravelTrip, TripStatus } from "@/lib/adminTypes";
import { ACCEPT_FILES, ADMIN_AUTO_REFRESH_MS, DURATIONS, FIELD_LABELS, HANDOFF_DURATION_CUSTOM, HANDOFF_DURATION_OPTIONS, MAX_AI_INPUT_CHARS, MAX_PARSE_UPLOAD_BYTES, QUICK_ACTIONS, SECRET_KEY, SECRET_TS_KEY, SESSION_TTL_MS, STATUS_LABELS, STATUS_TONE, apiErrorMessage, asInt, buildImageUploadUnit, buildOfficeUploadUnits, buildPdfUploadUnits, buildTextUploadUnits, buildZipImageUploadUnits, dataUrlToText, delayMs, describeAction, driveSyncTone, fileToDataUrl, formatBytes, formatMoneyValue, formatTime, getSecretStorage, getTestBotConversationId, handoffDurationSelectValue, isEditableElement, isImageFile, isOfficeDocFile, isPdfFile, isTextLikeFile, isTransientAiFailure, isZipFile, settingsToForm, shortId, splitLines, summarizeConflict, timeLeft, toStructuredRows, uid } from "@/lib/adminPageUtils";
const BLANK_TRIP_DRAFT: Record<string, string> = { category: "", operator_name: "", route_name: "", duration_text: "", adult_price: "", child_price: "", currency: "MNT", seats_total: "", seats_left: "", departure_dates: "", status: "active", has_food: "unknown", notes: "", hotel: "", source_description: "" };
const MAX_AI_SOURCE_TEXT_CHARS = 20_000;
export default function AdminPage() {
  const toast = useToast();
  const [secret, setSecret] = useState("");
  const [secretDraft, setSecretDraft] = useState("");
  const [requiresAuth, setRequiresAuth] = useState(false);
  const [openAccess, setOpenAccess] = useState(false);
  const [dbInfo, setDbInfo] = useState<{
    configured: boolean;
    schemaReady: boolean;
    trips: number;
    lastUpdatedAt: string | null;
  } | null>(null);
  const [driveSync, setDriveSync] = useState<DriveSyncDiagnostics | null>(null);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [systemLoaded, setSystemLoaded] = useState(false);
  const [tab, setTab] = useState<TabKey>("assistant");
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [tick, setTick] = useState(0);
  const [trips, setTrips] = useState<TravelTrip[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [control, setControl] = useState<ControlState | null>(null);
  const [pageControls, setPageControls] = useState<PageControlState[]>([]);
  const [pausedRows, setPausedRows] = useState<PauseRow[]>([]);
  const [recentRows, setRecentRows] = useState<RecentRow[]>([]);
  const [pauseReason, setPauseReason] = useState("");
  const [settings, setSettings] = useState<TravelBotSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState<SettingsForm | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "assistant",
      kind: "note",
      tone: "info",
      text:
        "Сайн байна уу! Аяллын мэдээллээ энд шуурхай өөрчилнө. Бичгээр зааварчилж болно (ж: «Бангкок аяллыг цуцал»), эсвэл прайс жагсаалт (Excel, PDF, зураг) хавсаргаарай. Би уншаад өөрчлөлтийг санал болгоно — та зөвшөөрвөл шууд хадгална.",
    },
  ]);
  const [aiInput, setAiInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [aiBusyLabel, setAiBusyLabel] = useState("");
  const [aiBusyProgress, setAiBusyProgress] = useState<number | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [editingTrip, setEditingTrip] = useState<TravelTrip | null>(null);
  const [isNewTrip, setIsNewTrip] = useState(false);
  const [tripDraft, setTripDraft] = useState<Record<string, string>>(
    BLANK_TRIP_DRAFT,
  );
  const [tripPhotoUrls, setTripPhotoUrls] = useState<string[]>([]);
  const [tripPhotoInput, setTripPhotoInput] = useState("");
  const [photoDragging, setPhotoDragging] = useState(false);
  const [photoUploading, setPhotoUploading] = useState<string[]>([]); // track uploading file names
  const [tripAliases, setTripAliases] = useState<string[]>([]);
  const [tripPriceGroups, setTripPriceGroups] = useState<PriceGroup[]>([]);
  const [tripDiscounts, setTripDiscounts] = useState<DiscountGroup[]>([]);
  const [tripChildRules, setTripChildRules] = useState<ChildRule[]>([]);
  const [tripExtraFees, setTripExtraFees] = useState<ExtraFee[]>([]);
  const [tripDepartureRule, setTripDepartureRule] = useState("");
  const [tripIncludedItems, setTripIncludedItems] = useState<string[]>([]);
  const [tripExcludedItems, setTripExcludedItems] = useState<string[]>([]);
  const [tripRoomPrices, setTripRoomPrices] = useState<RoomPrice[]>([]);
  const [tripImportantNotes, setTripImportantNotes] = useState<string[]>([]);
  const [tripCustomerVisible, setTripCustomerVisible] = useState<boolean>(true);
  const [tripNeedsHumanReview, setTripNeedsHumanReview] = useState<boolean>(false);
  const [tripReviewReasons, setTripReviewReasons] = useState<string[]>([]);
  const [tripSourceProvenance, setTripSourceProvenance] = useState<import("@/lib/adminTypes").SourceProvenance[]>([]);
  const [tripAnswerHints, setTripAnswerHints] = useState<import("@/lib/adminTypes").AnswerHint[]>([]);
  const [deletingTrip, setDeletingTrip] = useState<TravelTrip | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [photoReplaceConfirm, setPhotoReplaceConfirm] = useState<{ files: File[] } | null>(null);
  const [leads, setLeads] = useState<TravelLead[]>([]);
  const [newLeadCount, setNewLeadCount] = useState(0);
  const [leadStats, setLeadStats] = useState<LeadStats | null>(null);
  const [broadcastMessage, setBroadcastMessage] = useState("");
  const [broadcastSending, setBroadcastSending] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<{ sent: number; failed: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoFileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const secretRef = useRef(secret);
  const searchRef = useRef(search);
  const statusFilterRef = useRef(statusFilter);
  useEffect(() => {
    secretRef.current = secret;
  }, [secret]);
  useEffect(() => {
    searchRef.current = search;
  }, [search]);
  useEffect(() => {
    statusFilterRef.current = statusFilter;
  }, [statusFilter]);
  const fetchWithAdmin = useCallback(
    async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers || {});
      if (secretRef.current.trim()) {
        headers.set("x-admin-secret", secretRef.current.trim());
      }
      return fetch(url, { ...init, headers, cache: init?.cache ?? "no-store" });
    },
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
  const loadTrips = useCallback(
    async (
      nextSearch = searchRef.current,
      nextStatusFilter = statusFilterRef.current,
      options: { showLoading?: boolean } = {},
    ) => {
      if (options.showLoading) setLoading(true);
      try {
        const tripRes = await fetchWithAdmin(
          `/api/admin/trips?search=${encodeURIComponent(
            nextSearch,
          )}&status=${encodeURIComponent(nextStatusFilter)}&limit=300`,
        );
        if (tripRes.status === 401) {
          setRequiresAuth(true);
          return;
        }
        const tripJson = await tripRes.json();
        setRequiresAuth(false);
        setTrips(Array.isArray(tripJson?.trips) ? tripJson.trips : []);
        setControl((tripJson?.control as ControlState) || null);
      } catch {
        toast.error("Аяллын мэдээлэл ачаалж чадсангүй.");
      } finally {
        if (options.showLoading) setLoading(false);
      }
    },
    [fetchWithAdmin, toast],
  );
  const loadPauseState = useCallback(async () => {
    try {
      const pauseRes = await fetchWithAdmin("/api/pause");
      if (pauseRes.status === 401) {
        setRequiresAuth(true);
        return false;
      }
      const pauseJson = await pauseRes.json().catch(() => ({}));
      setRequiresAuth(false);
      setControl(pauseJson?.control || null);
      setPageControls(Array.isArray(pauseJson?.pages) ? pauseJson.pages : []);
      setPausedRows(Array.isArray(pauseJson?.paused) ? pauseJson.paused : []);
      setRecentRows(Array.isArray(pauseJson?.recent) ? pauseJson.recent : []);
      return true;
    } catch {
      toast.error("Ботын төлөв ачаалж чадсангүй.");
      return false;
    }
  }, [fetchWithAdmin, toast]);
  const loadSettingsState = useCallback(async () => {
    try {
      const settingsRes = await fetchWithAdmin("/api/admin/settings");
      if (settingsRes.status === 401) {
        setRequiresAuth(true);
        return false;
      }
      const settingsJson = await settingsRes.json().catch(() => ({}));
      setRequiresAuth(false);
      if (settingsJson?.settings) {
        setSettings(settingsJson.settings as TravelBotSettings);
        setSettingsForm((prev) =>
          prev ? prev : settingsToForm(settingsJson.settings as TravelBotSettings),
        );
      }
      return true;
    } catch {
      toast.error("Тохиргоо ачаалж чадсангүй.");
      return false;
    }
  }, [fetchWithAdmin, toast]);
  const loadLeadsState = useCallback(async (options: { showLoading?: boolean } = {}) => {
    if (options.showLoading) setLoading(true);
    try {
      const leadsRes = await fetchWithAdmin("/api/admin/leads?stats=1");
      if (leadsRes.status === 401) {
        setRequiresAuth(true);
        return false;
      }
      const leadsJson = await leadsRes.json().catch(() => ({}));
      setRequiresAuth(false);
      setLeads(Array.isArray(leadsJson?.leads) ? leadsJson.leads : []);
      setNewLeadCount(
        typeof leadsJson?.new_count === "number" ? leadsJson.new_count : 0,
      );
      setLeadStats(
        leadsJson?.stats && typeof leadsJson.stats === "object"
          ? (leadsJson.stats as LeadStats)
          : null,
      );
      return true;
    } catch {
      toast.error("Хүсэлтүүд ачаалж чадсангүй.");
      return false;
    } finally {
      if (options.showLoading) setLoading(false);
    }
  }, [fetchWithAdmin, toast]);
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const systemRes = await fetchWithAdmin("/api/admin/system");
      if (systemRes.status === 401) {
        setRequiresAuth(true);
        setLoading(false);
        return;
      }
      const systemJson = await systemRes.json();
      const nextOpenAccess = Boolean(systemJson?.open_access);
      const authorized = Boolean(systemJson?.authorized);
      setOpenAccess(nextOpenAccess);
      if (!nextOpenAccess && !authorized) {
        setRequiresAuth(true);
        setDbInfo(null);
        setDriveSync(null);
        setReadiness(null);
        setLoading(false);
        return;
      }
      setRequiresAuth(false);
      setDbInfo(systemJson?.db || null);
      setDriveSync((systemJson?.drive_sync as DriveSyncDiagnostics) || null);
      setReadiness((systemJson?.readiness as ReadinessReport) || null);
      setSystemLoaded(true);
      setLoading(false);
      await Promise.all([
        loadTrips(searchRef.current, statusFilterRef.current),
        loadPauseState(),
        loadSettingsState(),
        loadLeadsState(),
      ]);
    } catch {
      toast.error("Системийн өгөгдөл ачаалж чадсангүй.");
    } finally {
      setLoading(false);
    }
  }, [
    fetchWithAdmin,
    loadLeadsState,
    loadPauseState,
    loadSettingsState,
    loadTrips,
    toast,
  ]);
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
  useEffect(() => {
    const storage = getSecretStorage();
    if (!storage) return;
    const stored = storage.getItem(SECRET_KEY) || "";
    const ts = Number(storage.getItem(SECRET_TS_KEY) || "0");
    if (stored && Date.now() - ts < SESSION_TTL_MS) {
      secretRef.current = stored;
      setSecret(stored);
      setSecretDraft(stored);
      storage.setItem(SECRET_TS_KEY, String(Date.now()));
    } else if (stored) {
      storage.removeItem(SECRET_KEY);
      storage.removeItem(SECRET_TS_KEY);
    }
  }, []);
  useEffect(() => {
    void loadAll();
  }, [loadAll]);
  useEffect(() => {
    if (requiresAuth || (!openAccess && !secret.trim())) return;
    const timer = window.setTimeout(() => {
      void loadTrips(search, statusFilter, { showLoading: true });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [loadTrips, openAccess, requiresAuth, search, secret, statusFilter]);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (ADMIN_AUTO_REFRESH_MS <= 0) return;
    const refresh = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
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
  useEffect(() => {
    const PAUSE_POLL_MS = 5_000;
    const poll = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void loadPauseState();
    }, PAUSE_POLL_MS);
    return () => clearInterval(poll);
  }, [loadPauseState]);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);
  const pausedIds = useMemo(
    () => new Set(pausedRows.map((row) => row.sender_id)),
    [pausedRows],
  );
  const handoffRows = useMemo(
    () => pausedRows.filter((row) => row.reason === "handoff"),
    [pausedRows],
  );
  async function applySecret() {
    const nextSecret = secretDraft.trim();
    if (!nextSecret) return;
    const storage = getSecretStorage();
    if (storage) {
      storage.setItem(SECRET_KEY, nextSecret);
      storage.setItem(SECRET_TS_KEY, String(Date.now()));
    }
    secretRef.current = nextSecret;
    setSecret(nextSecret);
    await loadAll();
  }
  function pushMessage(message: ChatMessage) {
    setChatMessages((prev) => [...prev, message]);
  }
  async function readAttachedFile(file: File): Promise<AttachedFile> {
    return {
      id: `${file.name}:${file.size}:${file.lastModified}`,
      name: file.name,
      mimeType: file.type || "",
      sizeBytes: file.size,
      file,
    };
  }
  async function attachFiles(files: FileList | File[]) {
    const inputFiles = Array.from(files);
    if (inputFiles.length === 0) return;
    const limitedFiles = inputFiles;
    try {
      const nextFiles = await Promise.all(
        limitedFiles.map((file) => readAttachedFile(file)),
      );
      setAttachedFiles((prev) => {
        const existing = new Set(prev.map((file) => file.id));
        const deduped = nextFiles.filter((file) => !existing.has(file.id));
        return [...prev, ...deduped];
      });
    } catch {
      toast.error("Нэг буюу хэд хэдэн файлыг уншиж чадсангүй.");
    }
  }
  function mergeAIProposals(
    proposals: AIProposal[],
    fileNames: string[],
  ): AIProposal {
    const actionKeys = new Set<string>();
    const actions: AIAction[] = [];
    const conflicts = new Set<string>();
    const conflictItems = new Map<string, ConflictItem>();
    const importantReasons = new Set<string>();
    const summaries = new Set<string>();
    for (const proposal of proposals) {
      for (const action of proposal.actions || []) {
        const key = JSON.stringify(action);
        if (actionKeys.has(key)) continue;
        actionKeys.add(key);
        actions.push(action);
      }
      for (const conflict of proposal.conflicts || []) {
        if (conflict.trim()) conflicts.add(conflict.trim());
      }
      for (const item of proposal.conflict_items || []) {
        if (item.text?.trim()) conflictItems.set(item.text.trim(), item);
      }
      if (proposal.important_reason?.trim()) {
        importantReasons.add(proposal.important_reason.trim());
      }
      if (proposal.summary?.trim()) {
        summaries.add(proposal.summary.trim());
      }
    }
    return {
      summary:
        actions.length > 0
          ? `${fileNames.length} файл уншиж ${actions.length} өөрчлөлтийн санал оллоо.`
          : Array.from(summaries)[0] || "Файлуудаас хэрэгжүүлэх өөрчлөлт олдсонгүй.",
      needs_confirmation:
        proposals.some((proposal) => proposal.needs_confirmation) ||
        conflicts.size > 0,
      important_reason: Array.from(importantReasons).join(" "),
      conflicts: Array.from(conflicts),
      conflict_items: Array.from(conflictItems.values()),
      actions,
    };
  }
  async function parseUploadUnitWithRetry(
    unit: ParseUploadUnit,
    note: string,
    progressLabel: string,
  ): Promise<{ proposal: AIProposal; requestId: number | null }> {
    const MAX_HARD_FAILURES = 6; // consecutive non-rate-limit failures
    let hardFailures = 0;
    let waitAttempt = 0;
    while (true) {
      let res: Response;
      try {
        res = await fetchWithAdmin("/api/admin/parse-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploads: [
              {
                filename: unit.filename,
                mimeType: unit.mimeType,
                dataBase64: unit.dataUrl,
              },
              ...(unit.companions || []).map((companion) => ({
                filename: companion.filename,
                mimeType: companion.mimeType,
                dataBase64: companion.dataUrl,
              })),
            ],
            note,
          }),
        });
      } catch {
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) {
          return emptyChunkResult(unit.displayName);
        }
        await waitWithCountdown(progressLabel, 15_000, ++waitAttempt);
        continue;
      }
      const json = (await readJsonSafe(res)) as AIProposalResponse;
      const rateLimited = res.status === 429;
      const transientOk =
        res.ok &&
        isTransientAiFailure(json.proposal) &&
        !json.proposal?.actions?.length;
      if (rateLimited || transientOk) {
        const waitMs =
          typeof json.retry_after_ms === "number" && json.retry_after_ms > 0
            ? json.retry_after_ms
            : Math.min(60_000, 20_000 + waitAttempt * 10_000);
        await waitWithCountdown(progressLabel, waitMs, ++waitAttempt);
        continue;
      }
      if (!res.ok) {
        if (res.status === 413) {
          return emptyChunkResult(unit.displayName);
        }
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) {
          return emptyChunkResult(unit.displayName);
        }
        await waitWithCountdown(progressLabel, 15_000, ++waitAttempt);
        continue;
      }
      if (!json.proposal || !Array.isArray(json.proposal.actions)) {
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) {
          return emptyChunkResult(unit.displayName);
        }
        await waitWithCountdown(progressLabel, 10_000, ++waitAttempt);
        continue;
      }
      return {
        proposal: json.proposal,
        requestId: typeof json.request_id === "number" ? json.request_id : null,
      };
    }
  }
  async function waitWithCountdown(
    progressLabel: string,
    totalMs: number,
    attempt: number,
  ) {
    const stepMs = 1_000;
    let remaining = Math.max(stepMs, Math.round(totalMs));
    while (remaining > 0) {
      const secs = Math.ceil(remaining / 1000);
      setAiBusyLabel(
        `${progressLabel} — AI түр завгүй байна, ${secs}с дараа үргэлжилнэ` +
          (attempt > 3 ? ` (оролдлого ${attempt})` : ""),
      );
      await delayMs(Math.min(stepMs, remaining));
      remaining -= stepMs;
    }
  }
  function emptyChunkResult(displayName: string): {
    proposal: AIProposal;
    requestId: number | null;
  } {
    return {
      proposal: {
        summary: `"${displayName}" хэсгийг бүрэн уншиж чадсангүй.`,
        needs_confirmation: true,
        important_reason:
          "Энэ хэсгийн мэдээлэл хадгалагдаагүй. Бусад уншигдсан файлын үр дүнг үргэлжлүүлэн бэлдлээ.",
        conflicts: [`"${displayName}" хэсгийг дахин шалгах шаардлагатай.`],
        actions: [],
      },
      requestId: null,
    };
  }
  async function parseDriveFileWithRetry(
    fileId: string,
    note: string,
    progressLabel: string,
  ): Promise<{ proposal: AIProposal; requestId: number | null }> {
    const MAX_HARD_FAILURES = 6;
    let hardFailures = 0;
    let waitAttempt = 0;
    const label = `Google Drive ${shortId(fileId)}`;
    while (true) {
      let res: Response;
      try {
        res = await fetchWithAdmin("/api/admin/parse-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ driveFileIds: [fileId], note }),
        });
      } catch {
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) return emptyChunkResult(label);
        await waitWithCountdown(progressLabel, 15_000, ++waitAttempt);
        continue;
      }
      const json = (await readJsonSafe(res)) as AIProposalResponse;
      const rateLimited = res.status === 429;
      const transientOk =
        res.ok &&
        isTransientAiFailure(json.proposal) &&
        !json.proposal?.actions?.length;
      if (rateLimited || transientOk) {
        const waitMs =
          typeof json.retry_after_ms === "number" && json.retry_after_ms > 0
            ? json.retry_after_ms
            : Math.min(60_000, 20_000 + waitAttempt * 10_000);
        await waitWithCountdown(progressLabel, waitMs, ++waitAttempt);
        continue;
      }
      if (!res.ok) {
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) return emptyChunkResult(label);
        await waitWithCountdown(progressLabel, 15_000, ++waitAttempt);
        continue;
      }
      if (!json.proposal || !Array.isArray(json.proposal.actions)) {
        hardFailures += 1;
        if (hardFailures >= MAX_HARD_FAILURES) return emptyChunkResult(label);
        await waitWithCountdown(progressLabel, 10_000, ++waitAttempt);
        continue;
      }
      return {
        proposal: json.proposal,
        requestId: typeof json.request_id === "number" ? json.request_id : null,
      };
    }
  }
  async function parseAttachedFiles(
    files: AttachedFile[],
    note: string,
  ): Promise<{ proposal: AIProposal; requestId: number | null; sourceText: string }> {
    const proposals: AIProposal[] = [];
    setAiBusyProgress((current) => Math.max(current ?? 0, 8));
    let singleRequestId: number | null = null;
    const uploadUnits: ParseUploadUnit[] = [];
    const skippedFiles: string[] = [];
    for (const file of files) {
      try {
        if (isPdfFile(file.file)) {
          uploadUnits.push(...(await buildPdfUploadUnits(file.file)));
        } else if (isOfficeDocFile(file.file)) {
          uploadUnits.push(...(await buildOfficeUploadUnits(file.file)));
        } else if (isTextLikeFile(file.file)) {
          uploadUnits.push(...(await buildTextUploadUnits(file.file)));
        } else if (isImageFile(file.file)) {
          uploadUnits.push(await buildImageUploadUnit(file.file));
        } else if (isZipFile(file.file)) {
          uploadUnits.push(...(await buildZipImageUploadUnits(file.file)));
        } else {
          if (file.file.size > MAX_PARSE_UPLOAD_BYTES) {
            skippedFiles.push(file.name);
            continue;
          }
          uploadUnits.push({
            displayName: file.name,
            filename: file.name,
            mimeType: file.mimeType,
            dataUrl: await fileToDataUrl(file.file),
          });
        }
      } catch {
        skippedFiles.push(file.name);
      }
    }
    if (skippedFiles.length > 0) {
      toast.info(
        `${skippedFiles.length} файлыг уншиж чадсангүй тул алгаслаа: ${skippedFiles
          .slice(0, 3)
          .join(", ")}${skippedFiles.length > 3 ? "…" : ""}`,
      );
    }
    const sourceParts: string[] = [];
    if (note.trim()) sourceParts.push(`Админы тэмдэглэл: ${note.trim()}`);
    for (const unit of uploadUnits) {
      if (unit.mimeType === "text/plain" || unit.filename.endsWith(".txt")) {
        const text = dataUrlToText(unit.dataUrl).trim();
        if (text) sourceParts.push(`[${unit.displayName}]\n${text}`);
      }
    }
    const sourceText = sourceParts.join("\n\n").slice(0, MAX_AI_SOURCE_TEXT_CHARS);
    if (uploadUnits.length === 0) {
      return {
        proposal: {
          summary: "Уншигдах файл олдсонгүй.",
          needs_confirmation: false,
          important_reason: "",
          conflicts: [],
          actions: [],
        },
        requestId: null,
        sourceText,
      };
    }
    setAiBusyProgress((current) => Math.max(current ?? 0, 15));
    const doneIndexes = new Set<number>();
    const results = await Promise.all(
      uploadUnits.map((unit, index) =>
        delayMs(index * 400).then(() =>
          parseUploadUnitWithRetry(
            unit,
            note,
            `${files.length} файл уншиж байна… ${index + 1}/${uploadUnits.length}`,
          ).then((result) => {
            setAiBusyProgress(() => {
              doneIndexes.add(index);
              const completed = doneIndexes.size;
              return Math.min(90, 15 + Math.round((completed / uploadUnits.length) * 75));
            });
            return result;
          }),
        ),
      ),
    );
    for (const parsed of results) {
      proposals.push(parsed.proposal);
    }
    if (uploadUnits.length === 1) {
      singleRequestId = results[0]?.requestId ?? null;
    }
    return {
      proposal:
        proposals.length === 1
          ? proposals[0]
          : mergeAIProposals(
              proposals,
              files.map((file) => file.name),
            ),
      requestId: singleRequestId,
      sourceText,
    };
  }
  async function parseDriveFileIds(
    fileIds: string[],
    note: string,
  ): Promise<{ proposal: AIProposal; requestId: number | null; sourceText: string }> {
    const proposals: AIProposal[] = [];
    let singleRequestId: number | null = null;
    for (let index = 0; index < fileIds.length; index += 1) {
      const fileId = fileIds[index];
      const progressLabel = `${fileIds.length} Google Drive файл уншиж байна… ${index + 1}/${fileIds.length}`;
      setAiBusyLabel(progressLabel);
      const parsed = await parseDriveFileWithRetry(fileId, note, progressLabel);
      proposals.push(parsed.proposal);
      setAiBusyProgress(
        Math.min(90, 15 + Math.round(((index + 1) / fileIds.length) * 75)),
      );
      if (fileIds.length === 1) {
        singleRequestId = parsed.requestId;
      }
    }
    return {
      proposal:
        proposals.length === 1
          ? proposals[0]
          : mergeAIProposals(
              proposals,
              fileIds.map((fileId) => `Google Drive ${shortId(fileId)}`),
            ),
      requestId: singleRequestId,
      sourceText: "",
    };
  }
  function removeAttachedFile(fileId: string) {
    setAttachedFiles((prev) => prev.filter((file) => file.id !== fileId));
  }
  async function sendAssistant() {
    const text = aiInput.trim();
    const files = attachedFiles;
    const driveFileIds = extractGoogleDriveFileIds(text);
    if (!text && files.length === 0 && driveFileIds.length === 0) return;
    if (busyKey === "ai-send") return;
    if (text.length > MAX_AI_INPUT_CHARS) {
      toast.error(
        `AI заавар хэт урт байна. ${MAX_AI_INPUT_CHARS} тэмдэгтээс богино бичнэ үү.`,
      );
      return;
    }
    const sourceNames = [
      ...files.map((file) => file.name),
      ...driveFileIds.map((fileId) => `Google Drive ${shortId(fileId)}`),
    ];
    pushMessage({
      id: uid(),
      role: "admin",
      text: text || "Файл орууллаа",
      fileNames: sourceNames,
    });
    setAiInput("");
    setAttachedFiles([]);
    setBusyKey("ai-send");
    setAiBusyProgress(
      files.length > 0 || driveFileIds.length > 0 ? 3 : null,
    );
    setAiBusyLabel(
      files.length > 0 || driveFileIds.length > 0
        ? `${Math.max(1, sourceNames.length)} файл уншиж байна… (хэдэн секунд)`
        : "AI хариу бэлдэж байна…",
    );
    try {
      let proposal: AIProposal | undefined;
      let requestId: number | null = null;
      let sourceText = "";
      if (files.length > 0 || driveFileIds.length > 0) {
        const parsedProposals: AIProposal[] = [];
        const parsedSourceNames: string[] = [];
        if (files.length > 0) {
          const parsed = await parseAttachedFiles(files, text);
          parsedProposals.push(parsed.proposal);
          parsedSourceNames.push(...files.map((file) => file.name));
          requestId = parsed.requestId;
          sourceText = parsed.sourceText;
        }
        if (driveFileIds.length > 0) {
          const parsedDrive = await parseDriveFileIds(driveFileIds, text);
          parsedProposals.push(parsedDrive.proposal);
          parsedSourceNames.push(
            ...driveFileIds.map((fileId) => `Google Drive ${shortId(fileId)}`),
          );
          requestId = files.length === 0 ? parsedDrive.requestId : null;
          sourceText = sourceText
            ? `${sourceText}\n\n${parsedDrive.sourceText}`.slice(0, MAX_AI_SOURCE_TEXT_CHARS)
            : parsedDrive.sourceText;
        }
        proposal =
          parsedProposals.length === 1
            ? parsedProposals[0]
            : mergeAIProposals(parsedProposals, parsedSourceNames);
        setAiBusyLabel("Олдсон мэдээллийг нэгтгэж, шалгаж байна…");
        setAiBusyProgress(96);
      } else {
        const res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: text }),
        });
        const json = await readJsonSafe(res);
        const data = json as AIProposalResponse;
        if (!res.ok) {
          throw new Error(apiErrorMessage(data, "AI санал үүсгэж чадсангүй."));
        }
        proposal = data.proposal;
        requestId = typeof data.request_id === "number" ? data.request_id : null;
      }
      if (!proposal || !Array.isArray(proposal.actions)) {
        throw new Error(
          "AI хэрэгжих санал буцааж чадсангүй. Илүү тодорхой зааварчилгаар дахин оролдоно уу.",
        );
      }
      if (proposal.actions.length === 0) {
        pushMessage({
          id: uid(),
          role: "assistant",
          kind: "note",
          tone: "info",
          text:
            proposal.conflicts?.[0] ||
            proposal.important_reason ||
            proposal.summary ||
            "Өөрчлөх зүйл олдсонгүй. Илүү дэлгэрэнгүй зааварчилга эсвэл өөр файл оруулна уу.",
        });
        return;
      }
      const fileInstruction =
        sourceNames.length > 0
          ? text
            ? `[File] ${sourceNames.join(", ")} - ${text}`
            : `[File] ${sourceNames.join(", ")}`
          : text;
      pushMessage({
        id: uid(),
        role: "assistant",
        kind: "proposal",
        proposal,
        requestId,
        instruction: fileInstruction,
        sourceNames,
        sourceText,
        status: "pending",
        confirmChecked: false,
        clarifications: buildProposalClarifications(proposal, [], sourceNames),
        clarificationAnswers: [],
        answeredClarificationIds: [],
        customReply: "",
      });
      setAiBusyProgress(100);
    } catch (err) {
      pushMessage({
        id: uid(),
        role: "assistant",
        kind: "note",
        tone: "error",
        text:
          err instanceof TypeError
            ? "Сервер хариу өгөхөөс өмнө байршуулалт амжилтгүй болсон. Сүлжээ, браузер эсвэл платформын бодит request limit-д хүрсэн байж магадгүй."
            : err instanceof Error
              ? err.message
              : "Алдаа гарлаа.",
      });
    } finally {
      setBusyKey("");
      setAiBusyProgress(null);
    }
  }
  function setProposalMessage(id: string, patch: Partial<ProposalMsg>) {
    setChatMessages((prev) =>
      prev.map((message) =>
        message.id === id && "kind" in message && message.kind === "proposal"
          ? { ...message, ...patch }
          : message,
      ),
    );
  }
  async function answerClarification(
    message: ProposalMsg,
    question: ClarificationQuestion,
    answer: string,
    markAnsweredIds?: string[],
    extraAnswers?: ClarificationAnswer[],
  ) {
    const trimmed = answer.trim();
    if (!trimmed) return;
    setBusyKey(`clarify-${message.id}`);
    try {
      let proposal: AIProposal | undefined;
      let newRequestId: number | null = message.requestId;
      if (message.requestId != null) {
        const res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request_id: message.requestId,
            clarification: trimmed,
          }),
        });
        const json = await readJsonSafe(res);
        if (!res.ok) {
          throw new Error(
            apiErrorMessage(json as AIProposalResponse, "Саналыг засаж чадсангүй."),
          );
        }
        proposal = json?.proposal as AIProposal | undefined;
      } else {
        const contextParts: string[] = [];
        if (message.sourceText) {
          contextParts.push(`Source text from uploaded files:\n${message.sourceText}`);
        }
        if (message.instruction) contextParts.push(message.instruction);
        if (message.clarificationAnswers.length > 0) {
          contextParts.push(
            "Previous clarification answers:\n" +
              message.clarificationAnswers
                .map((qa) => `${qa.prompt}: ${qa.answer}`)
                .join("\n"),
          );
        }
        contextParts.push(`${question.prompt}: ${trimmed}`);
        const instruction = contextParts.join("\n\n").slice(0, MAX_AI_INPUT_CHARS);
        const res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction }),
        });
        const json = await readJsonSafe(res);
        if (!res.ok) {
          throw new Error(
            apiErrorMessage(json as AIProposalResponse, "Саналыг засаж чадсангүй."),
          );
        }
        proposal = json?.proposal as AIProposal | undefined;
        if (typeof json?.request_id === "number") {
          newRequestId = json.request_id as number;
        }
      }
      if (!proposal || !Array.isArray(proposal.actions)) {
        throw new Error("AI засварласан санал буцааж чадсангүй.");
      }
      const nextAnsweredIds = markAnsweredIds ?? [
        ...message.answeredClarificationIds,
        question.id,
      ];
      const nextAnswers = [
        ...message.clarificationAnswers,
        ...(extraAnswers ?? [
          {
            questionId: question.id,
            prompt: question.prompt,
            answer: trimmed,
          },
        ]),
      ];
      setProposalMessage(message.id, {
        proposal,
        requestId: newRequestId,
        clarifications: buildProposalClarifications(proposal, nextAnsweredIds, message.sourceNames ?? []),
        clarificationAnswers: nextAnswers,
        answeredClarificationIds: nextAnsweredIds,
        customReply: "",
        confirmChecked: false,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Саналыг засаж чадсангүй.",
      );
    } finally {
      setBusyKey("");
    }
  }
  async function applyProposal(message: ProposalMsg) {
    setBusyKey(`apply-${message.id}`);
    try {
      const body =
        message.requestId != null
          ? { request_id: message.requestId, apply: true, confirm: true }
          : {
              apply: true,
              confirm: true,
              proposal_direct: message.proposal,
              instruction: message.instruction,
            };
      const res = await fetchWithAdmin("/api/admin/ai-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message || json?.error || "Хэрэгжүүлж чадсангүй.");
      }
      setProposalMessage(message.id, {
        status: "applied",
        requestId:
          typeof json?.request_id === "number"
            ? (json.request_id as number)
            : message.requestId,
        resultText: Array.isArray(json?.results)
          ? json.results.join(" • ")
          : json?.message || "Амжилттай.",
      });
      toast.success("Өөрчлөлт хадгалагдлаа. Бот шинэ мэдээллээр хариулна.");
      await loadAll();
    } catch (err) {
      setProposalMessage(message.id, {
        status: "error",
        resultText: err instanceof Error ? err.message : "Алдаа гарлаа.",
      });
      toast.error("Хэрэгжүүлэхэд алдаа гарлаа.");
    } finally {
      setBusyKey("");
    }
  }
  async function rollbackProposal(message: ProposalMsg) {
    if (message.requestId == null) {
      toast.error("Буцаах хадгалсан хүсэлтийн дугаар олдсонгүй.");
      return;
    }
    if (
      !window.confirm(
        "Сүүлд хадгалсан AI өөрчлөлтийг буцаах уу? Энэ үйлдэл тухайн өөрчлөлтийн өмнөх аяллын мэдээллийг сэргээнэ.",
      )
    ) {
      return;
    }
    setBusyKey(`rollback-${message.id}`);
    try {
      const res = await fetchWithAdmin("/api/admin/ai-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: message.requestId,
          rollback: true,
          confirm: true,
        }),
      });
      const json = await readJsonSafe(res);
      if (!res.ok) {
        throw new Error(
          String(json?.message || json?.error || "Буцааж чадсангүй."),
        );
      }
      setProposalMessage(message.id, {
        status: "reverted",
        resultText: Array.isArray(json?.results)
          ? json.results.join(" • ")
          : String(json?.message || "Буцаагдлаа."),
      });
      toast.success("AI өөрчлөлтийг буцаалаа.");
      await loadAll();
    } catch (err) {
      setProposalMessage(message.id, {
        status: "error",
        resultText: err instanceof Error ? err.message : "Буцаахад алдаа гарлаа.",
      });
      toast.error("Буцаахад алдаа гарлаа.");
    } finally {
      setBusyKey("");
    }
  }
  async function submitClarificationForm(
    message: ProposalMsg,
    answers: Record<string, string>,
  ) {
    const combined = message.clarifications
      .map((q) => {
        const answer = (answers[q.id] ?? "").trim();
        if (!answer) return "";
        const context = q.detail ? ` [Зөрчил: ${q.detail}]` : "";
        return `${q.prompt}${context} → ${answer}`;
      })
      .filter(Boolean)
      .join("\n");
    if (!combined.trim()) return;
    const allAnsweredIds = message.clarifications.map((q) => q.id);
    const newAnswers = message.clarifications
      .map((q) => {
        const answer = (answers[q.id] ?? "").trim();
        if (!answer) return null;
        return { questionId: q.id, prompt: q.prompt, answer };
      })
      .filter(Boolean) as ClarificationAnswer[];
    const firstQ = message.clarifications[0];
    if (!firstQ) return;
    await answerClarification(
      message,
      firstQ,
      combined,
      [...message.answeredClarificationIds, ...allAnsweredIds],
      newAnswers,
    );
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
  function beginCreateTrip() {
    setIsNewTrip(true);
    setEditingTrip(null);
    setTripDraft({ ...BLANK_TRIP_DRAFT });
    setTripPhotoUrls([]);
    setTripPhotoInput("");
    setTripAliases([]);
    setTripPriceGroups([]);
    setTripDiscounts([]);
    setTripChildRules([]);
    setTripExtraFees([]);
    setTripDepartureRule("");
    setTripIncludedItems([]);
    setTripExcludedItems([]);
    setTripRoomPrices([]);
    setTripImportantNotes([]);
    setTripCustomerVisible(true);
    setTripNeedsHumanReview(false);
    setTripReviewReasons([]);
    setTripSourceProvenance([]);
    setTripAnswerHints([]);
  }
  function beginEditTrip(trip: TravelTrip) {
    setIsNewTrip(false);
    setEditingTrip(trip);
    setTripDraft({
      category: trip.category || "",
      operator_name: trip.operator_name || "",
      route_name: trip.route_name || "",
      duration_text: trip.duration_text || "",
      adult_price: trip.adult_price == null ? "" : String(trip.adult_price),
      child_price: trip.child_price == null ? "" : String(trip.child_price),
      currency: trip.currency || "MNT",
      seats_total: trip.seats_total == null ? "" : String(trip.seats_total),
      seats_left: trip.seats_left == null ? "" : String(trip.seats_left),
      departure_dates: (trip.departure_dates || []).join(", "),
      status: trip.status || "active",
      has_food:
        trip.has_food == null ? "unknown" : trip.has_food ? "true" : "false",
      notes: trip.notes || "",
      hotel: trip.hotel || "",
      source_description: trip.source_description || "",
    });
    setTripPhotoUrls(trip.photo_urls || []);
    setTripPhotoInput("");
    setTripAliases(Array.isArray(trip.extra?.aliases) ? (trip.extra.aliases as string[]) : []);
    setTripPriceGroups(Array.isArray(trip.extra?.price_groups) ? (trip.extra.price_groups as PriceGroup[]) : []);
    setTripDiscounts(Array.isArray(trip.extra?.discounts) ? (trip.extra.discounts as DiscountGroup[]) : []);
    setTripChildRules(Array.isArray(trip.extra?.child_rules) ? (trip.extra.child_rules as ChildRule[]) : []);
    setTripExtraFees(Array.isArray(trip.extra?.extra_fees) ? (trip.extra.extra_fees as ExtraFee[]) : []);
    setTripDepartureRule(typeof trip.extra?.departure_rule === "string" ? trip.extra.departure_rule : "");
    setTripIncludedItems(Array.isArray(trip.extra?.included_items) ? (trip.extra.included_items as string[]) : []);
    setTripExcludedItems(Array.isArray(trip.extra?.excluded_items) ? (trip.extra.excluded_items as string[]) : []);
    setTripRoomPrices(Array.isArray(trip.extra?.room_prices) ? (trip.extra.room_prices as RoomPrice[]) : []);
    setTripImportantNotes(Array.isArray(trip.extra?.important_notes) ? (trip.extra.important_notes as string[]) : []);
    setTripCustomerVisible(typeof trip.extra?.customer_visible === "boolean" ? trip.extra.customer_visible : true);
    setTripNeedsHumanReview(typeof trip.extra?.needs_human_review === "boolean" ? trip.extra.needs_human_review : false);
    setTripReviewReasons(Array.isArray(trip.extra?.review_reasons) ? (trip.extra.review_reasons as string[]) : []);
    setTripSourceProvenance(Array.isArray(trip.extra?.source_provenance) ? (trip.extra.source_provenance as import("@/lib/adminTypes").SourceProvenance[]) : []);
    setTripAnswerHints(Array.isArray(trip.extra?.answer_hints) ? (trip.extra.answer_hints as import("@/lib/adminTypes").AnswerHint[]) : []);
  }
  const tripModalOpen = isNewTrip || editingTrip != null;
  async function doUploadPhotoFiles(files: File[], replace: boolean) {
    if (replace) setTripPhotoUrls([]);

    const baseCount = replace ? 0 : tripPhotoUrls.length;
    const availableSlots = Math.max(0, MAX_PHOTOS_PER_TRIP - baseCount);
    if (availableSlots === 0) {
      toast.error(`Нэг аялалд хамгийн ихдээ ${MAX_PHOTOS_PER_TRIP} зураг хадгална.`);
      return;
    }

    const fileArray = files.slice(0, availableSlots);
    if (fileArray.length < files.length) {
      toast.error(`Зургийн дээд тоо ${MAX_PHOTOS_PER_TRIP} тул үлдсэн файлуудыг алгаслаа.`);
    }
    if (fileArray.length === 0) return;

    const newNames = fileArray.map((file) => file.name);
    setPhotoUploading((prev) => [...prev, ...newNames]);

    const removeUploadingName = (names: string[], target: string) => {
      const index = names.indexOf(target);
      if (index === -1) return names;
      return [...names.slice(0, index), ...names.slice(index + 1)];
    };

    const uploadedUrls = (
      await Promise.all(
        fileArray.map(async (file) => {
          try {
            const sigRes = await fetchWithAdmin("/api/admin/upload-image", { method: "POST" });
            if (!sigRes.ok) {
              const sigJson = (await sigRes.json().catch(() => ({}))) as { error?: string };
              throw new Error(sigJson?.error ?? "Зураг оруулах тохиргоо олдсонгүй.");
            }
            const sigData = (await sigRes.json()) as {
              signature: string;
              timestamp: number;
              cloudName: string;
              apiKey: string;
              folder: string;
            };
            const formData = new FormData();
            formData.append("file", file);
            formData.append("api_key", sigData.apiKey);
            formData.append("timestamp", String(sigData.timestamp));
            formData.append("signature", sigData.signature);
            formData.append("folder", sigData.folder);
            const uploadRes = await fetch(
              `https://api.cloudinary.com/v1_1/${sigData.cloudName}/image/upload`,
              { method: "POST", body: formData },
            );
            const uploadJson = (await uploadRes.json()) as {
              secure_url?: string;
              error?: { message?: string };
            };
            if (!uploadRes.ok || !uploadJson.secure_url) {
              throw new Error(uploadJson?.error?.message ?? "Cloudinary upload амжилтгүй.");
            }
            return uploadJson.secure_url;
          } catch (err) {
            toast.error(
              `"${file.name}" зураг оруулж чадсангүй: ${err instanceof Error ? err.message : "алдаа"}`,
            );
            return null;
          } finally {
            setPhotoUploading((prev) => removeUploadingName(prev, file.name));
          }
        }),
      )
    ).filter((url): url is string => Boolean(url));

    if (uploadedUrls.length > 0) {
      setTripPhotoUrls((prev) => {
        const base = replace ? [] : prev;
        return [...base, ...uploadedUrls].slice(0, MAX_PHOTOS_PER_TRIP);
      });
    }
  }
  function handlePhotoFiles(files: FileList | File[]) {
    const validFiles = Array.from(files).filter((file) => file.size <= 10 * 1024 * 1024);
    if (validFiles.length < Array.from(files).length) {
      toast.error("10MB-ээс том зураг оруулах боломжгүй.");
    }
    if (validFiles.length === 0) return;
    if (tripPhotoUrls.length > 0) {
      setPhotoReplaceConfirm({ files: validFiles });
    } else {
      void doUploadPhotoFiles(validFiles, false);
    }
  }
  function closeTripModal() {
    setEditingTrip(null);
    setIsNewTrip(false);
  }
  async function saveTrip() {
    if (photoUploading.length > 0) {
      toast.error("Зураг байршуулж дуусаагүй байна. Дууссаны дараа хадгална уу.");
      return;
    }

    const fields = {
      category: tripDraft.category || "",
      operator_name: tripDraft.operator_name || "",
      route_name: tripDraft.route_name || "",
      duration_text: tripDraft.duration_text || "",
      adult_price: asInt(tripDraft.adult_price || ""),
      child_price: asInt(tripDraft.child_price || ""),
      currency: tripDraft.currency || "MNT",
      seats_total: asInt(tripDraft.seats_total || ""),
      seats_left: asInt(tripDraft.seats_left || ""),
      status: tripDraft.status || "active",
      has_food:
        tripDraft.has_food === "unknown"
          ? null
          : tripDraft.has_food === "true",
      notes: tripDraft.notes || "",
      hotel: tripDraft.hotel || "",
      departure_dates: (tripDraft.departure_dates || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      source_description: tripDraft.source_description || "",
      photo_urls: tripPhotoUrls,
      extra: {
        aliases: tripAliases.filter(Boolean),
        price_groups: tripPriceGroups,
        discounts: tripDiscounts,
        child_rules: tripChildRules,
        extra_fees: tripExtraFees,
        departure_rule: tripDepartureRule.trim(),
        included_items: tripIncludedItems.filter(Boolean),
        excluded_items: tripExcludedItems.filter(Boolean),
        room_prices: tripRoomPrices,
        important_notes: tripImportantNotes.filter(Boolean),
        customer_visible: tripCustomerVisible,
        needs_human_review: tripNeedsHumanReview,
        review_reasons: tripReviewReasons.filter(Boolean),
        source_provenance: tripSourceProvenance,
        answer_hints: tripAnswerHints,
      },
    };
    if (!fields.route_name.trim()) {
      toast.error("Аяллын нэр оруулна уу.");
      return;
    }
    if (isNewTrip) {
      const duplicate = trips.find(
        (t) =>
          t.operator_name.trim().toLowerCase() ===
            fields.operator_name.trim().toLowerCase() &&
          t.route_name.trim().toLowerCase() ===
            fields.route_name.trim().toLowerCase(),
      );
      if (duplicate) {
        toast.error(
          `"${fields.operator_name} — ${fields.route_name}" нэртэй аялал аль хэдийн байна. Засах товч дарж шинэчилнэ үү.`,
        );
        return;
      }
    }
    setBusyKey("save-trip");
    try {
      const res = await fetchWithAdmin("/api/admin/trips", {
        method: isNewTrip ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isNewTrip ? { fields } : { id: editingTrip?.id, fields },
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Хадгалж чадсангүй.");
      toast.success(isNewTrip ? "Шинэ аялал нэмэгдлээ." : "Аялал шинэчлэгдлээ.");
      closeTripModal();
      await loadTrips(searchRef.current, statusFilterRef.current, {
        showLoading: true,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Хадгалж чадсангүй.");
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
      toast.success(`"${trip.route_name || trip.operator_name}" устгагдлаа.`);
      await loadTrips(searchRef.current, statusFilterRef.current, {
        showLoading: true,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Устгаж чадсангүй.");
    } finally {
      setBusyKey("");
    }
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
        toast.error(`Алдаа: ${json.error || "server_error"}`);
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
  async function saveSettings() {
    if (!settingsForm) return;
    setBusyKey("save-settings");
    try {
      const fields = {
        business_name: settingsForm.business_name.trim(),
        system_prompt: settingsForm.system_prompt.trim(),
        quick_info_reply: settingsForm.quick_info_reply.trim(),
        quick_info_keywords: splitLines(settingsForm.quick_info_keywords),
        comment_trigger_patterns: splitLines(
          settingsForm.comment_trigger_patterns,
        ),
        comment_public_reply: settingsForm.comment_public_reply.trim(),
        comment_dm_reply: settingsForm.comment_dm_reply.trim(),
        special_offers: settingsForm.special_offers,
        discount_policies: settingsForm.discount_policies,
        verified_credentials: settingsForm.verified_credentials,
        faq: settingsForm.faq,
        handoff_enabled: settingsForm.handoff_enabled,
        handoff_keywords: splitLines(settingsForm.handoff_keywords),
        handoff_reply: settingsForm.handoff_reply.trim(),
        handoff_pause_minutes: asInt(settingsForm.handoff_pause_minutes) ?? 60,
        chat_buttons: settingsForm.chat_buttons,
      };
      const res = await fetchWithAdmin("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Тохиргоо хадгалж чадсангүй.");
      if (json?.settings) {
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
  const botPaused = Boolean(control?.bot_paused);
  function selectAdminTab(nextTab: TabKey) {
    setTab(nextTab);
    setMobileNavOpen(false);
  }
  if (requiresAuth || (!openAccess && !secret.trim())) {
    return (
      <AdminLoginGate
        secretDraft={secretDraft}
        onSecretDraftChange={setSecretDraft}
        onSubmit={() => void applySecret()}
      />
    );
  }
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas">
      <Head>
        <title>Аяллын удирдлагын самбар</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-3 shadow-xs sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            aria-label="Цэс нээх"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((open) => !open)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-sunken md:hidden"
          >
            {mobileNavOpen ? <Icons.close size={20} /> : <Icons.menu size={20} />}
          </button>
          <span className="truncate text-sm font-semibold text-ink">Уудам Трэвел Admin</span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          {handoffRows.length > 0 && (
            <button type="button" onClick={() => setTab("bot")}>
              <Badge tone="warning" dot>
                🙋 {handoffRows.length}
              </Badge>
            </button>
          )}
          <Badge tone={botPaused ? "danger" : "success"} dot>
            {botPaused ? "Бот зогссон" : "Бот идэвхтэй"}
          </Badge>
          <span className="hidden sm:inline-flex">
            <Badge tone={dbInfo?.configured ? "neutral" : "danger"}>
              {dbInfo?.trips ?? trips.length} аялал
            </Badge>
          </span>
        </div>
      </header>
      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {mobileNavOpen && (
          <button
            type="button"
            aria-label="Цэс хаах"
            className="fixed inset-0 top-14 z-30 bg-ink/25 backdrop-blur-[1px] md:hidden"
            onClick={() => setMobileNavOpen(false)}
          />
        )}
        {/* Sidebar */}
        <aside className={cx(
          "fixed bottom-0 left-0 top-14 z-40 flex w-[17rem] shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-surface p-3 shadow-lg transition-transform md:static md:z-auto md:w-60 md:translate-x-0 md:shadow-none",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full",
        )}>
          <AdminSidebarItem
            icon={<Icons.ai size={16} />}
            label="AI туслах"
            active={tab === "assistant"}
            onClick={() => selectAdminTab("assistant")}
          />
          <AdminSidebarItem
            icon={<Icons.trips size={16} />}
            label="Аяллууд"
            active={tab === "trips"}
            onClick={() => selectAdminTab("trips")}
          />
          <AdminSidebarItem
            icon={<Icons.chevronRight size={16} />}
            label="Мэндчилгээ"
            active={tab === "greeting"}
            onClick={() => selectAdminTab("greeting")}
          />
          <AdminSidebarItem
            icon={<Icons.refresh size={16} />}
            label="Улирал"
            active={tab === "seasons"}
            onClick={() => selectAdminTab("seasons")}
          />
          <AdminSidebarItem
            icon={<Icons.image size={16} />}
            label="Зураг оруулах"
            active={tab === "photos"}
            onClick={() => selectAdminTab("photos")}
          />
          <AdminSidebarItem
            icon={<Icons.image size={16} />}
            label="Постер үүсгэгч"
            active={tab === "poster"}
            onClick={() => selectAdminTab("poster")}
          />
          <AdminSidebarItem
            icon={<Icons.control size={16} />}
            label="Ботын хяналт"
            active={tab === "bot"}
            badge={handoffRows.length || undefined}
            onClick={() => selectAdminTab("bot")}
          />
          <AdminSidebarItem
            icon={<Icons.alert size={16} />}
            label="Хүсэлтүүд"
            active={tab === "leads"}
            badge={newLeadCount || undefined}
            onClick={() => selectAdminTab("leads")}
          />
          <AdminSidebarItem
            icon={<Icons.settings size={16} />}
            label="Тохиргоо"
            active={tab === "settings"}
            onClick={() => selectAdminTab("settings")}
          />
          <AdminSidebarItem
            icon={<Icons.control size={16} />}
            label="Аналитик"
            active={tab === "analytics"}
            onClick={() => selectAdminTab("analytics")}
          />
          <AdminSidebarItem
            icon={<Icons.play size={16} />}
            label="Урсгал"
            active={tab === "flow"}
            onClick={() => selectAdminTab("flow")}
          />
          <AdminSidebarItem
            icon={<Icons.download size={16} />}
            label="Төлбөр"
            active={tab === "payments"}
            onClick={() => selectAdminTab("payments")}
          />
          <AdminSidebarItem
            icon={<Icons.chevronRight size={16} />}
            label="JSON засвар"
            active={tab === "json"}
            onClick={() => selectAdminTab("json")}
          />
        </aside>
        {/* Content */}
        <main className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-4 md:p-6">
          {/* Bot-paused is already shown as a badge in the topbar — no banner. */}
          {systemLoaded && !dbInfo?.configured && (
            <div className="mb-4">
              <Alert tone="danger">
                Өгөгдлийн сан холбогдоогүй байна. Мэдээлэл хадгалагдахгүй.
              </Alert>
            </div>
          )}
          {readiness && readiness.issues.length > 0 && (
            <div className="mb-4">
              <Alert
                tone={
                  readiness.issues.some((issue) => issue.severity === "critical")
                    ? "danger"
                    : "warning"
                }
              >
                Бэлэн байдлын оноо {readiness.score}/10.{" "}
                {readiness.issues
                  .slice(0, 2)
                  .map((issue) => issue.message)
                  .join(" ")}
              </Alert>
            </div>
          )}
          {tab === "assistant" && (
            <AssistantTab
              messages={chatMessages}
              existingTrips={trips}
              aiInput={aiInput}
              setAiInput={setAiInput}
              attachedFiles={attachedFiles}
              onRemoveAttachedFile={removeAttachedFile}
              dragOver={dragOver}
              setDragOver={setDragOver}
              busy={busyKey === "ai-send"}
              busyLabel={aiBusyLabel}
              busyProgress={aiBusyProgress}
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
              onSend={() => void sendAssistant()}
              onApply={(message) => void applyProposal(message)}
              onRollback={(message) => void rollbackProposal(message)}
              onSubmitClarificationForm={(message, answers) =>
                void submitClarificationForm(message, answers)
              }
              onCancelProposal={(id) =>
                setProposalMessage(id, { status: "cancelled" })
              }
              onToggleConfirm={(id, value) =>
                setProposalMessage(id, { confirmChecked: value })
              }
              onPickFile={() => fileInputRef.current?.click()}
              onDropFiles={(files) => void attachFiles(files)}
              chatEndRef={chatEndRef}
              inputRef={inputRef}
            />
          )}
          {tab === "trips" && (
            <TripsTab
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
              onDeleteAll={async () => {
                try {
                  const res = await fetchWithAdmin(`/api/admin/trips?all=true`, {
                    method: "DELETE",
                  });
                  const json = await res.json();
                  if (!res.ok) throw new Error(json?.error || "failed");
                  toast.success(`${json.deleted ?? 0} аялал устгагдлаа`);
                  void loadTrips("", "", { showLoading: true });
                } catch {
                  toast.error("Устгахад алдаа гарлаа.");
                }
              }}
            />
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
              tick={tick}
              apiFetch={fetchWithAdmin}
              onPauseAction={(action, senderId, ms, pageId) =>
                void runPauseAction(action, senderId, ms, pageId)
              }
              onSettingsChanged={() => void loadSettingsState()}
            />
          )}
          {tab === "leads" && (
            <LeadsTab
              leads={leads}
              stats={leadStats}
              loading={loading}
              onRefresh={() => void loadLeadsState({ showLoading: true })}
              onMarkSeen={(lead) => void markLeadSeen(lead)}
              onUpdateStatus={(lead, status) => void updateLeadCrmStatus(lead, status)}
              broadcastMessage={broadcastMessage}
              broadcastSending={broadcastSending}
              broadcastResult={broadcastResult}
              onBroadcastChange={setBroadcastMessage}
              onBroadcastSend={() => void sendBroadcast()}
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
            <AnalyticsTab apiFetch={fetchWithAdmin} />
          )}
          {tab === "flow" && (
            <FlowBuilderTab
              extra={(settings?.extra ?? {}) as Record<string, unknown>}
              apiFetch={fetchWithAdmin}
              onSaved={loadAll}
            />
          )}
          {tab === "payments" && <PaymentsTab apiFetch={fetchWithAdmin} />}
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
            <PosterTab apiFetch={fetchWithAdmin} />
          )}
          {tab === "json" && (
            <JsonEditorTab
              apiFetch={fetchWithAdmin}
              onSaved={loadAll}
            />
          )}
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
          if (files?.length) void attachFiles(files);
          e.target.value = "";
        }}
      />
      {/* Trip edit / create modal */}
      <TripEditModal
        open={tripModalOpen}
        isNewTrip={isNewTrip}
        editingTrip={editingTrip}
        tripDraft={tripDraft}
        setTripDraft={setTripDraft}
        tripPhotoUrls={tripPhotoUrls}
        setTripPhotoUrls={setTripPhotoUrls}
        tripPhotoInput={tripPhotoInput}
        setTripPhotoInput={setTripPhotoInput}
        photoDragging={photoDragging}
        setPhotoDragging={setPhotoDragging}
        photoUploading={photoUploading}
        photoFileInputRef={photoFileInputRef}
        saveDisabled={photoUploading.length > 0}
        busyKey={busyKey}
        handlePhotoFiles={handlePhotoFiles}
        onClose={closeTripModal}
        onSave={() => void saveTrip()}
        tripAliases={tripAliases}
        setTripAliases={setTripAliases}
        tripPriceGroups={tripPriceGroups}
        setTripPriceGroups={setTripPriceGroups}
        tripDiscounts={tripDiscounts}
        setTripDiscounts={setTripDiscounts}
        tripChildRules={tripChildRules}
        setTripChildRules={setTripChildRules}
        tripExtraFees={tripExtraFees}
        setTripExtraFees={setTripExtraFees}
        tripDepartureRule={tripDepartureRule}
        setTripDepartureRule={setTripDepartureRule}
        tripIncludedItems={tripIncludedItems}
        setTripIncludedItems={setTripIncludedItems}
        tripExcludedItems={tripExcludedItems}
        setTripExcludedItems={setTripExcludedItems}
        tripRoomPrices={tripRoomPrices}
        setTripRoomPrices={setTripRoomPrices}
        tripImportantNotes={tripImportantNotes}
        setTripImportantNotes={setTripImportantNotes}
        tripCustomerVisible={tripCustomerVisible}
        setTripCustomerVisible={setTripCustomerVisible}
        tripNeedsHumanReview={tripNeedsHumanReview}
        setTripNeedsHumanReview={setTripNeedsHumanReview}
        tripReviewReasons={tripReviewReasons}
        setTripReviewReasons={setTripReviewReasons}
        tripSourceProvenance={tripSourceProvenance}
        tripAnswerHints={tripAnswerHints}
        setTripAnswerHints={setTripAnswerHints}
      />
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
      <Modal
        open={photoReplaceConfirm != null}
        onClose={() => setPhotoReplaceConfirm(null)}
        title="Хуучин зургуудыг устгах уу?"
      >
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">
            Энэ аялалд <span className="font-semibold text-ink">{tripPhotoUrls.length}</span> зураг байна.
            Шинэ {photoReplaceConfirm?.files.length ?? 0} зурган дээр нэмэх үү, эсвэл хуучныг устгаад солих уу?
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setPhotoReplaceConfirm(null)}>
              Болих
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                const files = photoReplaceConfirm?.files ?? [];
                setPhotoReplaceConfirm(null);
                void doUploadPhotoFiles(files, false);
              }}
            >
              <Icons.plus size={15} />
              Нэмэх
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const files = photoReplaceConfirm?.files ?? [];
                setPhotoReplaceConfirm(null);
                void doUploadPhotoFiles(files, true);
              }}
            >
              <Icons.trash size={15} />
              Хуучныг устгаад солих
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
