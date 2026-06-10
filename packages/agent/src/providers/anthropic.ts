import type { AgentProvider, AnthropicOptions } from "../types.js";
import { streamMessages } from "./wire.js";

/** Pinned non-thinking Sonnet — no dropped thinking blocks in streams. */
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

let warnedBrowser = false;

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Direct Anthropic Messages API provider (raw fetch, streaming SSE — no SDK
 * dependency). Browser use with an apiKey THROWS unless
 * `dangerouslyAllowBrowser` is set, and warns once even with it: keys in
 * browsers are visible to anyone with devtools — ship proxy() +
 * createAgentHandler() instead.
 */
export function anthropic(opts: AnthropicOptions = {}): AgentProvider {
  const apiKey = opts.apiKey;
  const baseURL = stripTrailingSlash(opts.baseURL ?? DEFAULT_BASE_URL);
  const model = opts.model ?? DEFAULT_MODEL;

  if (typeof window !== "undefined" && apiKey) {
    if (!opts.dangerouslyAllowBrowser) {
      throw new Error(
        "@josharsh/webmcp-agent: anthropic() received an apiKey in a browser. " +
          "The key would be visible to anyone who opens devtools. Use " +
          "proxy({ url }) with createAgentHandler() from " +
          '"@josharsh/webmcp-agent/server" in production, or pass ' +
          "{ dangerouslyAllowBrowser: true } if you accept the exposure " +
          "(local development only).",
      );
    }
    if (!warnedBrowser) {
      warnedBrowser = true;
      console.warn(
        "@josharsh/webmcp-agent: anthropic() is running in the browser with " +
          "an API key (dangerouslyAllowBrowser). Anyone who can open " +
          "devtools can read this key. For production, switch to " +
          "proxy({ url }) backed by createAgentHandler().",
      );
    }
  }

  return {
    id: "anthropic",
    label: "Claude (Anthropic)",
    kind: "remote",
    chat: (request) =>
      streamMessages(
        { baseURL, model, ...(apiKey !== undefined && { apiKey }) },
        request,
      ),
  };
}

/**
 * Same wire protocol as anthropic(), pointed at your server's
 * createAgentHandler() route. Sends no key and no dangerous-browser header;
 * omits `model` unless given so the server-side pin applies.
 */
export function proxy(opts: { url: string; model?: string }): AgentProvider {
  const baseURL = stripTrailingSlash(opts.url);
  return {
    id: "proxy",
    label: "Claude (proxied)",
    kind: "remote",
    chat: (request) =>
      streamMessages(
        { baseURL, ...(opts.model !== undefined && { model: opts.model }) },
        request,
      ),
  };
}
