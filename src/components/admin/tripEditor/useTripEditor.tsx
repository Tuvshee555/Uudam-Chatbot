/**
 * The trip editor's state and its open / save / photo-upload handlers, moved out of
 * pages/admin.tsx (over the 2,000-line cap). One editor serves a saved trip, a new trip
 * and a trip read from a file that is not saved yet (draft mode: its save hands the
 * changed fields back to the AI review instead of writing the trip).
 */
import { useRef, useState } from "react";
import { Button, Icons, Modal, useToast } from "@/components/ui";
import type { TripEditModalProps } from "@/components/admin/TripEditModal";
import type { AnswerHint, BookingTerms, DiscountGroup, ExtraFee, ItineraryDay, PriceGroup, RoomPrice, SourceProvenance, TravelTrip } from "@/lib/adminTypes";
import { emptyBookingTerms } from "@/lib/adminTypes";
import { isTripListProjection } from "@/lib/tripListProjection";
import { MAX_PHOTOS_PER_TRIP } from "@/lib/tripPhotoImport/types";
import { BLANK_TRIP_DRAFT, blankEditorState, changedEditorFields, editorStateToFields, tripToEditorState, type TripEditorState } from "@/lib/tripEditorState";

type Row = Record<string, unknown>;

export type TripEditorDeps = {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  readJsonSafe: (response: Response) => Promise<Row>;
  /** The session ended (401): the page signs out. */
  onLocked: () => void;
  /** The trips on screen, for the duplicate-name check of a new trip. */
  trips: TravelTrip[];
  setBusyKey: (key: string) => void;
  /** After a save: reload the list. */
  onSaved: () => Promise<void> | void;
};

export function useTripEditor({ apiFetch, readJsonSafe, onLocked, trips, setBusyKey, onSaved }: TripEditorDeps) {
  const toast = useToast();
  const [editingTrip, setEditingTrip] = useState<TravelTrip | null>(null);
  const [openingTripId, setOpeningTripId] = useState("");
  const [isNewTrip, setIsNewTrip] = useState(false);
  const [tripDraft, setTripDraft] = useState<Record<string, string>>(BLANK_TRIP_DRAFT);
  const [tripPhotoUrls, setTripPhotoUrls] = useState<string[]>([]);
  const [tripPhotoInput, setTripPhotoInput] = useState("");
  const [photoDragging, setPhotoDragging] = useState(false);
  const [photoUploading, setPhotoUploading] = useState<string[]>([]); // file names still uploading
  const [photoReplaceConfirm, setPhotoReplaceConfirm] = useState<{ files: File[] } | null>(null);
  const photoFileInputRef = useRef<HTMLInputElement>(null);
  const [tripAliases, setTripAliases] = useState<string[]>([]);
  const [tripPriceGroups, setTripPriceGroups] = useState<PriceGroup[]>([]);
  const [tripDiscounts, setTripDiscounts] = useState<DiscountGroup[]>([]);
  const [tripExtraFees, setTripExtraFees] = useState<ExtraFee[]>([]);
  const [tripDepartureRule, setTripDepartureRule] = useState("");
  const [tripIncludedItems, setTripIncludedItems] = useState<string[]>([]);
  const [tripExcludedItems, setTripExcludedItems] = useState<string[]>([]);
  const [tripRoomPrices, setTripRoomPrices] = useState<RoomPrice[]>([]);
  const [tripItineraryDays, setTripItineraryDays] = useState<ItineraryDay[]>([]);
  const [tripImportantNotes, setTripImportantNotes] = useState<string[]>([]);
  const [tripBookingTerms, setTripBookingTerms] = useState<BookingTerms>(emptyBookingTerms());
  const [tripCustomerVisible, setTripCustomerVisible] = useState<boolean>(true);
  const [tripNeedsHumanReview, setTripNeedsHumanReview] = useState<boolean>(false);
  const [tripReviewReasons, setTripReviewReasons] = useState<string[]>([]);
  const [tripSourceProvenance, setTripSourceProvenance] = useState<SourceProvenance[]>([]);
  const [tripAnswerHints, setTripAnswerHints] = useState<AnswerHint[]>([]);
  // Set while the full editor is open on a trip read from a file: its save returns the fields here.
  const draftReturnRef = useRef<((fields: Row) => void) | null>(null);
  const draftCountRef = useRef(0);
  const [editorDraftKey, setEditorDraftKey] = useState(0);
  // The fields as the editor showed them when the trip opened: a save sends only what differs from these.
  const editorBaselineRef = useRef<ReturnType<typeof editorStateToFields> | null>(null);
  const draftHadProfilesRef = useRef(false);

  /** Puts a whole editor state on screen (tripEditorState.ts builds it). */
  function applyEditorState(state: TripEditorState) {
    setTripDraft(state.tripDraft);
    setTripPhotoUrls(state.tripPhotoUrls);
    setTripPhotoInput("");
    setTripAliases(state.tripAliases);
    setTripPriceGroups(state.tripPriceGroups);
    setTripDiscounts(state.tripDiscounts);
    setTripExtraFees(state.tripExtraFees);
    setTripDepartureRule(state.tripDepartureRule);
    setTripIncludedItems(state.tripIncludedItems);
    setTripExcludedItems(state.tripExcludedItems);
    setTripRoomPrices(state.tripRoomPrices);
    setTripItineraryDays(state.tripItineraryDays);
    setTripImportantNotes(state.tripImportantNotes);
    setTripBookingTerms(state.tripBookingTerms);
    setTripCustomerVisible(state.tripCustomerVisible);
    setTripNeedsHumanReview(state.tripNeedsHumanReview);
    setTripReviewReasons(state.tripReviewReasons);
    setTripSourceProvenance(state.tripSourceProvenance);
    setTripAnswerHints(state.tripAnswerHints);
  }
  function beginCreateTrip() {
    draftReturnRef.current = null;
    setEditorDraftKey(0);
    setIsNewTrip(true);
    setEditingTrip(null);
    applyEditorState(blankEditorState());
  }
  /**
   * The full editor on a trip read from a file and not saved yet. Its save
   * hands the changed fields back to the review (onDone) instead of writing the trip.
   */
  function openTripEditorForDraft(fields: Row, onDone: (fields: Row) => void) {
    draftReturnRef.current = onDone;
    draftCountRef.current += 1;
    setEditorDraftKey(draftCountRef.current);
    setIsNewTrip(true);
    setEditingTrip(null);
    const state = tripToEditorState(fields as Partial<TravelTrip>);
    // What the editor shows at open: only what differs from it goes back to the review.
    draftHadProfilesRef.current = Array.isArray((fields.extra as Row | undefined)?.hotel_profiles);
    editorBaselineRef.current = editorStateToFields(state, null, { hadProfiles: draftHadProfilesRef.current });
    applyEditorState(state);
  }
  function openTripEditor(trip: TravelTrip) {
    draftReturnRef.current = null;
    setEditorDraftKey(0);
    setIsNewTrip(false);
    setEditingTrip(trip);
    const state = tripToEditorState(trip);
    editorBaselineRef.current = editorStateToFields(state, trip);
    applyEditorState(state);
  }
  /**
   * Opens the editor on the trip as saved now. The list holds slim rows (no website copy,
   * itinerary text or conflict history) that may also be a refresh old; editing from them
   * would show empty fields and lead to avoidable "changed elsewhere" conflicts.
   */
  async function beginEditTrip(trip: TravelTrip) {
    if (openingTripId) return;
    setOpeningTripId(trip.id);
    try {
      const res = await apiFetch(`/api/admin/trips?id=${encodeURIComponent(trip.id)}`);
      if (res.status === 401) {
        onLocked();
        return;
      }
      const json = await readJsonSafe(res) as { trip?: TravelTrip; message?: string };
      if (!res.ok || !json.trip) throw new Error(json.message || "Аяллыг нээж чадсангүй. Дахин оролдоно уу.");
      openTripEditor(json.trip);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Аяллыг нээж чадсангүй. Дахин оролдоно уу.");
    } finally {
      setOpeningTripId("");
    }
  }
  function closeTripModal() {
    draftReturnRef.current = null;
    setEditorDraftKey(0);
    setEditingTrip(null);
    setIsNewTrip(false);
  }

  async function doUploadPhotoFiles(files: File[], replace: boolean) {
    if (replace) setTripPhotoUrls([]);
    const baseCount = replace ? 0 : tripPhotoUrls.length;
    const availableSlots = Math.max(0, MAX_PHOTOS_PER_TRIP - baseCount);
    if (availableSlots === 0) {
      toast.error(`Нэг аялалд хамгийн ихдээ ${MAX_PHOTOS_PER_TRIP} зураг хадгална.`);
      return;
    }
    const fileArray = files.slice(0, availableSlots);
    if (fileArray.length < files.length) toast.error(`Зургийн дээд тоо ${MAX_PHOTOS_PER_TRIP} тул үлдсэн файлуудыг алгаслаа.`);
    if (fileArray.length === 0) return;
    setPhotoUploading((prev) => [...prev, ...fileArray.map((file) => file.name)]);
    const removeUploadingName = (names: string[], target: string) => {
      const index = names.indexOf(target);
      return index === -1 ? names : [...names.slice(0, index), ...names.slice(index + 1)];
    };
    const uploadedUrls = (await Promise.all(fileArray.map(async (file) => {
      try {
        const sigRes = await apiFetch("/api/admin/upload-image", { method: "POST" });
        if (!sigRes.ok) {
          const sigJson = (await sigRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(sigJson?.error ?? "Зураг оруулах тохиргоо олдсонгүй.");
        }
        const sigData = (await sigRes.json()) as { signature: string; timestamp: number; cloudName: string; apiKey: string; folder: string };
        const formData = new FormData();
        formData.append("file", file);
        formData.append("api_key", sigData.apiKey);
        formData.append("timestamp", String(sigData.timestamp));
        formData.append("signature", sigData.signature);
        formData.append("folder", sigData.folder);
        const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${sigData.cloudName}/image/upload`, { method: "POST", body: formData });
        const uploadJson = (await uploadRes.json()) as { secure_url?: string; error?: { message?: string } };
        if (!uploadRes.ok || !uploadJson.secure_url) throw new Error(uploadJson?.error?.message ?? "Cloudinary upload амжилтгүй.");
        return uploadJson.secure_url;
      } catch (err) {
        toast.error(`"${file.name}" зураг оруулж чадсангүй: ${err instanceof Error ? err.message : "алдаа"}`);
        return null;
      } finally {
        setPhotoUploading((prev) => removeUploadingName(prev, file.name));
      }
    }))).filter((url): url is string => Boolean(url));
    if (uploadedUrls.length > 0) {
      setTripPhotoUrls((prev) => [...(replace ? [] : prev), ...uploadedUrls].slice(0, MAX_PHOTOS_PER_TRIP));
    }
  }
  function handlePhotoFiles(files: FileList | File[]) {
    const validFiles = Array.from(files).filter((file) => file.size <= 10 * 1024 * 1024);
    if (validFiles.length < Array.from(files).length) toast.error("10MB-ээс том зураг оруулах боломжгүй.");
    if (validFiles.length === 0) return;
    if (tripPhotoUrls.length > 0) setPhotoReplaceConfirm({ files: validFiles });
    else void doUploadPhotoFiles(validFiles, false);
  }

  /** confirmIncomplete is set once the editor's "save anyway" prompt is accepted. */
  async function saveTrip(confirmIncomplete = false) {
    if (photoUploading.length > 0) {
      toast.error("Зураг байршуулж дуусаагүй байна. Дууссаны дараа хадгална уу.");
      return;
    }
    // Defensive: the editor only ever opens on a full trip (beginEditTrip).
    if (editingTrip && isTripListProjection(editingTrip)) {
      toast.error("Аяллын бүрэн мэдээлэл ачаалагдаагүй байна. Цонхыг хаагаад дахин нээнэ үү.");
      return;
    }
    const fields = editorStateToFields({
      tripDraft, tripPhotoUrls, tripAliases, tripPriceGroups, tripDiscounts, tripExtraFees, tripDepartureRule, tripIncludedItems,
      tripExcludedItems, tripRoomPrices, tripItineraryDays, tripImportantNotes, tripBookingTerms, tripCustomerVisible,
      tripNeedsHumanReview, tripReviewReasons, tripSourceProvenance, tripAnswerHints,
    }, editingTrip, draftReturnRef.current ? { hadProfiles: draftHadProfilesRef.current } : {});
    if (!fields.route_name.trim()) {
      toast.error("Аяллын нэр оруулна уу.");
      return;
    }
    // A trip read from a file: the review saves it, as a draft or published. Only what was
    // changed here goes back; defaults the editor filled in are not the file's facts.
    if (draftReturnRef.current) {
      const done = draftReturnRef.current;
      const baseline = editorBaselineRef.current;
      closeTripModal();
      done(baseline ? changedEditorFields(baseline, fields) : fields);
      return;
    }
    if (isNewTrip) {
      const same = (value: string) => value.trim().toLowerCase();
      const duplicate = trips.find((t) => same(t.operator_name) === same(fields.operator_name) && same(t.route_name) === same(fields.route_name));
      if (duplicate) {
        toast.error(`"${fields.operator_name} — ${fields.route_name}" нэртэй аялал аль хэдийн байна. Засах товч дарж шинэчилнэ үү.`);
        return;
      }
    }
    setBusyKey("save-trip");
    try {
      // Only what was changed in the editor (compared with what it showed at open). Compared with the
      // raw record, defaults the editor fills in (age bands, a switched-off sale badge) looked like
      // edits, and an untouched trip was saved again. openTripEditor always sets the baseline.
      const patchFields: Row = editingTrip
        ? changedEditorFields(editorBaselineRef.current ?? editorStateToFields(tripToEditorState(editingTrip), editingTrip), fields) : fields;
      const changedExtra = (patchFields.extra ?? {}) as Row;
      if (editingTrip && !("price_groups" in changedExtra)
        && tripDraft.child_price_free !== "true" && tripDraft.infant_price_free !== "true") delete changedExtra.child_rules;
      if (editingTrip && patchFields.extra && !Object.keys(changedExtra).length) delete patchFields.extra;
      if (!Object.keys(patchFields).length) {
        toast.success("Өөрчлөлт ороогүй байна.");
        closeTripModal();
        return;
      }
      const res = await apiFetch("/api/admin/trips", {
        method: isNewTrip ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isNewTrip
          ? { fields, confirmIncomplete }
          : { id: editingTrip?.id, fields: patchFields, confirmIncomplete, expectedUpdatedAt: editingTrip?.updated_at }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || json?.error || "Хадгалж чадсангүй.");
      toast.success(isNewTrip ? "Шинэ аялал нэмэгдлээ." : "Аялал шинэчлэгдлээ.");
      closeTripModal();
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Хадгалж чадсангүй.");
    } finally {
      setBusyKey("");
    }
  }

  const tripModalOpen = isNewTrip || editingTrip != null;
  const modalProps: Omit<TripEditModalProps, "busyKey" | "apiFetch" | "onAskAi"> = {
    open: tripModalOpen, isNewTrip, editingTrip, tripDraft, setTripDraft, tripPhotoUrls, setTripPhotoUrls, tripPhotoInput, setTripPhotoInput,
    photoDragging, setPhotoDragging, photoUploading, photoFileInputRef, saveDisabled: photoUploading.length > 0, handlePhotoFiles,
    onClose: closeTripModal, onSave: (confirmIncomplete) => void saveTrip(confirmIncomplete),
    tripAliases, setTripAliases, tripPriceGroups, setTripPriceGroups, tripDiscounts, setTripDiscounts, tripExtraFees, setTripExtraFees,
    tripDepartureRule, setTripDepartureRule, tripIncludedItems, setTripIncludedItems, tripExcludedItems, setTripExcludedItems,
    tripRoomPrices, setTripRoomPrices, tripItineraryDays, setTripItineraryDays, tripImportantNotes, setTripImportantNotes,
    tripBookingTerms, setTripBookingTerms, tripCustomerVisible, setTripCustomerVisible, tripNeedsHumanReview, setTripNeedsHumanReview,
    tripReviewReasons, setTripReviewReasons, tripSourceProvenance, tripAnswerHints, setTripAnswerHints,
    draftMode: editorDraftKey > 0, draftKey: editorDraftKey,
  };
  const uploadReplacing = (replace: boolean) => {
    const files = photoReplaceConfirm?.files ?? [];
    setPhotoReplaceConfirm(null);
    void doUploadPhotoFiles(files, replace);
  };
  const photoReplaceModal = (
    <Modal open={photoReplaceConfirm != null} onClose={() => setPhotoReplaceConfirm(null)} title="Хуучин зургуудыг устгах уу?">
      <div className="space-y-3">
        <p className="text-sm text-ink-muted">
          Энэ аялалд <span className="font-semibold text-ink">{tripPhotoUrls.length}</span> зураг байна.
          Шинэ {photoReplaceConfirm?.files.length ?? 0} зурган дээр нэмэх үү, эсвэл хуучныг устгаад солих уу?
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => setPhotoReplaceConfirm(null)}>Болих</Button>
          <Button variant="secondary" onClick={() => uploadReplacing(false)}><Icons.plus size={15} />Нэмэх</Button>
          <Button variant="danger" onClick={() => uploadReplacing(true)}><Icons.trash size={15} />Хуучныг устгаад солих</Button>
        </div>
      </div>
    </Modal>
  );

  return {
    editingTrip, isNewTrip, tripModalOpen, openingTripId,
    beginCreateTrip, beginEditTrip, openTripEditorForDraft, closeTripModal,
    modalProps, photoReplaceModal,
  };
}
