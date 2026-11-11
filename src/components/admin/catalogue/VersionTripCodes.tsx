import { useState } from "react";
import { Badge } from "@/components/ui";
import type { CatalogueVersionTripsResponse, CatalogueVersionView } from "@/lib/catalogue/admin/types";
import type { CatalogueAdmin } from "./useCatalogueAdmin";

/**
 * "Кодууд": the trips a stored version printed with the persistent code each carries. Read from the version's
 * own snapshot, so a trip shows the same code here as in every other edition and in the Messenger follow-up.
 */
export function VersionTripCodes({ admin, version }: { admin: CatalogueAdmin; version: CatalogueVersionView }) {
  const [state, setState] = useState<{ open: boolean; data: CatalogueVersionTripsResponse | null; error: string | null; loading: boolean }>({ open: false, data: null, error: null, loading: false });

  async function toggle() {
    if (state.open) return setState({ ...state, open: false });
    if (state.data) return setState({ ...state, open: true });
    setState({ open: true, data: null, error: null, loading: true });
    try {
      setState({ open: true, data: await admin.api.versionTrips(version.id), error: null, loading: false });
    } catch (err) {
      setState({ open: true, data: null, error: err instanceof Error ? err.message : "Жагсаалтыг ачаалж чадсангүй.", loading: false });
    }
  }

  return (
    <div className="mt-1">
      <button type="button" onClick={() => void toggle()} aria-expanded={state.open} className="text-xs font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-brand">
        {state.open ? "Кодыг нуух" : "Аяллын кодууд"}
      </button>
      {state.open && (
        <div className="mt-1.5" aria-live="polite">
          {state.loading && <p className="text-xs text-ink-muted">Ачаалж байна…</p>}
          {state.error && <p className="text-xs text-danger">{state.error}</p>}
          {state.data && (
            <ul className="space-y-1" aria-label={`v${version.versionNo} дахь аяллын кодууд`}>
              {state.data.trips.map((trip) => (
                <li key={trip.tripId} className="flex items-center gap-2 text-xs text-ink">
                  <Badge tone="brand">{trip.code}</Badge>
                  <span className="min-w-0 break-words">{trip.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
