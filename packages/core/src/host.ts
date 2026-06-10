import { installPonyfill } from "./ponyfill.js";
import type { ModelContext, WebMCPKitConfig } from "./types.js";

/**
 * Resolve a native ModelContext host.
 *
 * The current spec draft exposes `document.modelContext`; earlier revisions
 * (and some experimental implementations) used `navigator.modelContext`.
 * We accept either so the kit works against both shapes.
 */
function nativeHost(): ModelContext | undefined {
  if (typeof document !== "undefined" && document.modelContext) {
    return document.modelContext;
  }
  if (typeof navigator !== "undefined") {
    const nav = navigator as Navigator & { modelContext?: ModelContext };
    if (nav.modelContext?.registerTool) return nav.modelContext;
  }
  return undefined;
}

/** True when the browser natively implements WebMCP (document or navigator). */
export function hasNativeWebMCP(): boolean {
  const host = nativeHost();
  return (
    typeof host?.registerTool === "function" &&
    !(host as { __webmcpKitPonyfill?: true }).__webmcpKitPonyfill
  );
}

/** True when any host (native or ponyfill) is available. */
export function hasWebMCP(): boolean {
  return typeof nativeHost()?.registerTool === "function";
}

/**
 * Resolve the ModelContext host according to the configured missing-host
 * strategy. Returns null for "noop".
 */
export function getModelContext(
  missingHost: Required<WebMCPKitConfig>["missingHost"],
): ModelContext | null {
  if (typeof document === "undefined") {
    if (missingHost === "throw") {
      throw new Error(
        "webmcp-tools: no document available (are you in a server context?)",
      );
    }
    return null;
  }
  const native = nativeHost();
  if (native) return native;
  switch (missingHost) {
    case "ponyfill":
      return installPonyfill(document);
    case "noop":
      return null;
    case "throw":
      throw new Error(
        "webmcp-tools: WebMCP (document.modelContext / navigator.modelContext) " +
          'is not available in this browser and missingHost is "throw". ' +
          "Chrome 149+ ships WebMCP behind an origin trial; use the default " +
          "ponyfill strategy elsewhere.",
      );
  }
}
