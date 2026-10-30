/**
 * The Graph API version every Meta call uses. Meta retires a version about two years after
 * release and then silently answers with the oldest live one: on 2026-10-30 the calls pinned
 * to v19.0 were all served as v25.0, the app's default (takeover diagnostics). One place to
 * move forward; META_GRAPH_API_VERSION overrides it without a code change.
 */
const configured = process.env.META_GRAPH_API_VERSION || "";
export const GRAPH_API_VERSION = /^v\d+\.\d+$/.test(configured) ? configured : "v25.0";

export const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
