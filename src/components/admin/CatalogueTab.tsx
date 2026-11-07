import { useState } from "react";
import { Alert, Button, Icons } from "@/components/ui";
import { LoadingPanel, TabHeader } from "./AdminShared";
import type { CatalogueEdition } from "@/lib/catalogue/types";
import { CurationPanel } from "./catalogue/CurationPanel";
import { GenerateFlow } from "./catalogue/GenerateFlow";
import { ReviewPanel } from "./catalogue/ReviewPanel";
import { StatsPanel } from "./catalogue/StatsPanel";
import { TestSendPanel } from "./catalogue/TestSendPanel";
import { VersionsPanel } from "./catalogue/VersionsPanel";
import { SubTabs, TabPanel, type SubTab } from "./catalogue/shared";
import { useCatalogueAdmin } from "./catalogue/useCatalogueAdmin";

type SectionKey = "versions" | "curation" | "review" | "publish" | "test" | "stats";

const SECTIONS: Array<SubTab<SectionKey>> = [
  { key: "versions", label: "Хувилбарууд" },
  { key: "curation", label: "Сонголт" },
  { key: "review", label: "Шалгалт" },
  { key: "publish", label: "Үүсгэх ба нийтлэх" },
  { key: "test", label: "Туршилтын илгээлт" },
  { key: "stats", label: "Статистик" },
];

const ID_PREFIX = "catalogue";

/**
 * "Аяллын каталог": the corporate PDF catalogue's control room. Published versions and their
 * freshness, trip selection, per-trip review, Generate -> Preview -> Publish, a safe test send
 * and delivery counts. Trip facts are always read live; only staff curation is stored.
 */
export function CatalogueTab({ apiFetch }: { apiFetch: (url: string, init?: RequestInit) => Promise<Response> }) {
  const admin = useCatalogueAdmin(apiFetch);
  const [section, setSection] = useState<SectionKey>("versions");
  const [focusVersionId, setFocusVersionId] = useState<string | null>(null);
  const [generateEdition, setGenerateEdition] = useState<CatalogueEdition>("quick");

  const staleEditions = admin.state
    ? (["quick", "complete"] as const).filter((edition) => admin.state?.editions[edition].freshness.status === "stale")
    : [];

  function previewVersion(versionId: string) {
    setFocusVersionId(versionId);
    setSection("publish");
  }

  function goGenerate(edition: CatalogueEdition) {
    setGenerateEdition(edition);
    setFocusVersionId(null);
    setSection("publish");
  }

  return (
    <div className="space-y-5">
      <TabHeader
        icon={<Icons.file size={20} />}
        title="Аяллын каталог"
        description="Байгууллага, хамт олонд Messenger-ээр илгээх нэг PDF каталог. Үнэ, огноо, зураг бүгд аяллын сангаас шууд уншигдана: энд хуулбарлан хадгалахгүй."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void admin.reload()} loading={admin.loading}>
            <Icons.refresh size={14} />
            Шинэчлэх
          </Button>
        }
      />

      {admin.error && (
        <Alert tone="danger">
          {admin.error}{" "}
          <button type="button" className="font-semibold underline" onClick={() => void admin.reload()}>Дахин оролдох</button>
        </Alert>
      )}
      {staleEditions.length > 0 && section !== "versions" && (
        <Alert tone="warning">
          {staleEditions.map((edition) => (edition === "quick" ? "Хурдан" : "Бүрэн")).join(" ба ")} каталогийн нийтлэгдсэн хувилбар хуучирсан байна.{" "}
          <button type="button" className="font-semibold underline" onClick={() => setSection("versions")}>Шалтгааныг харах</button>
        </Alert>
      )}

      {admin.loading && !admin.state ? (
        <LoadingPanel />
      ) : !admin.state ? null : (
        <>
          <SubTabs tabs={SECTIONS} value={section} onChange={setSection} label="Каталогийн хэсгүүд" idPrefix={ID_PREFIX} />
          <TabPanel idPrefix={ID_PREFIX} tabKey={section}>
            {section === "versions" && <VersionsPanel admin={admin} onPreview={previewVersion} onGenerate={goGenerate} />}
            {section === "curation" && <CurationPanel admin={admin} />}
            {section === "review" && <ReviewPanel admin={admin} />}
            {section === "publish" && <GenerateFlow admin={admin} focusVersionId={focusVersionId} initialEdition={generateEdition} onPublished={() => setSection("versions")} />}
            {section === "test" && <TestSendPanel admin={admin} />}
            {section === "stats" && <StatsPanel admin={admin} />}
          </TabPanel>
        </>
      )}
    </div>
  );
}
