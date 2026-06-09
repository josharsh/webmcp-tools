import { installPonyfill } from "./ponyfill.js";
import type { ModelContext, WebMCPKitConfig } from "./types.js";

/** True when the browser natively implements `document.modelContext`. */
export function hasNativeWebMCP(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.modelContext?.registerTool === "function" &&
    !(document.modelContext as { __webmcpKitPonyfill?: true })
      .__webmcpKitPonyfill
  );
}

/** True when any host (native or ponyfill) is available. */
export function hasWebMCP(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.modelContext?.registerTool === "function"
  );
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
        "webmcp-kit: no document available (are you in a server context?)",
      );
    }
    return null;
  }
  if (document.modelContext) return document.modelContext;
  switch (missingHost) {
    case "ponyfill":
      return installPonyfill(document);
    case "noop":
      return null;
    case "throw":
      throw new Error(
        "webmcp-kit: document.modelContext is not available in this browser " +
          'and missingHost is "throw". Chrome 149+ ships WebMCP behind an ' +
          "origin trial; use the default ponyfill strategy elsewhere.",
      );
  }
}
