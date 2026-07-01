import type { ComponentType } from "react";

/** Poster generator tab. apiFetch injects the admin secret header. */
declare const PosterTab: ComponentType<{
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}>;
export default PosterTab;
