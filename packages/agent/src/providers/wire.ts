import { ProviderError } from "../types.js";
import type {
  ChatMessage,
  Json,
  ProviderChatRequest,
  ProviderEvent,
} from "../types.js";

/**
 * Shared Anthropic Messages API wire implementation. anthropic() and proxy()
 * are two factories over this one transport: proxy() simply points baseURL at
 * the app's server handler and sends no key (and no model unless given).
 */
export interface WireOptions {
  baseURL: string;
  /** Omitted from the request body when undefined (server pins it). */
  model?: string;
  /** When present: x-api-key + anthropic-dangerous-direct-browser-access. */
  apiKey?: string;
}

const ANTHROPIC_VERSION = "2023-06-01";

/** Replace any occurrence of the API key in a string (error redaction). */
function redact(text: string, apiKey?: string): string {
  if (!apiKey || apiKey.length === 0) return text;
  return text.split(apiKey).join("sk-ant-…[redacted]");
}

function toWireMessage(message: ChatMessage): Json {
  return {
    role: message.role,
    content: message.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError && { is_error: true }),
      };
    }),
  };
}

function buildBody(opts: WireOptions, request: ProviderChatRequest): string {
  return JSON.stringify({
    ...(opts.model !== undefined && { model: opts.model }),
    max_tokens: request.maxTokens,
    stream: true,
    system: request.system,
    messages: request.messages.map(toWireMessage),
    ...(request.tools.length > 0 && {
      tools: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    }),
  });
}

function buildHeaders(opts: WireOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (opts.apiKey) {
    headers["x-api-key"] = opts.apiKey;
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  return headers;
}

function mapStopReason(
  raw: string | null,
): "end-turn" | "tool-use" | "max-tokens" {
  if (raw === "tool_use") return "tool-use";
  if (raw === "max_tokens") return "max-tokens";
  return "end-turn";
}

interface ToolUseBlock {
  id: string;
  name: string;
  json: string;
}

/**
 * POST {baseURL}/v1/messages with stream: true and translate the SSE stream
 * into ProviderEvents.
 *
 * Parser notes (verified against the Anthropic streaming docs):
 * - TextDecoder(stream: true) — safe when UTF-8 multi-byte chars split across
 *   network chunks.
 * - Events are separated by blank lines; CRLF tolerated; events themselves
 *   can split across chunks; `:` keep-alive comments skipped.
 * - Per content_block index: content_block_start of type tool_use captures
 *   {id, name}; input_json_delta.partial_json concatenated and JSON.parsed at
 *   content_block_stop (empty buffer → {} — the first delta is often "").
 * - text_delta forwarded immediately; stop_reason from message_delta; ping
 *   and ALL unknown event/delta types skipped silently (versioning policy —
 *   tolerates thinking_delta).
 * - `event: error` (or an error payload) and malformed data JSON → throw
 *   ProviderError.
 */
export async function* streamMessages(
  opts: WireOptions,
  request: ProviderChatRequest,
): AsyncGenerator<ProviderEvent, void, undefined> {
  let response: Response;
  try {
    response = await fetch(`${opts.baseURL}/v1/messages`, {
      method: "POST",
      headers: buildHeaders(opts),
      body: buildBody(opts, request),
      signal: request.signal,
    });
  } catch (err) {
    if (request.signal.aborted) throw err; // propagate aborts untouched
    const message = err instanceof Error ? err.message : String(err);
    throw new ProviderError(
      `Anthropic request failed: ${redact(message, opts.apiKey)}`,
      { cause: err },
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    throw new ProviderError(
      `Anthropic API error ${response.status}: ${redact(detail, opts.apiKey)}`,
      { status: response.status },
    );
  }
  if (!response.body) {
    throw new ProviderError("Anthropic API returned no response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const blocks = new Map<number, ToolUseBlock>();
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  let stopReason: string | null = null;
  let sawMessageStop = false;
  // Unparseable tool input is only fatal when the message completed normally.
  // When max_tokens truncates the stream mid input_json_delta, the partial
  // call is dropped and the consumer still gets done(stopReason:
  // "max-tokens") — stop_reason arrives AFTER content_block_stop, so the
  // error must be deferred, not thrown at parse time.
  let toolInputError: ProviderError | null = null;

  const pendingEvents: ProviderEvent[] = [];

  function parseData(eventName: string | null, data: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      throw new ProviderError(
        `Anthropic stream sent malformed JSON for event "${eventName ?? "message"}"`,
        { cause: err },
      );
    }
    const type = (payload.type as string) ?? eventName ?? "";

    switch (type) {
      case "error": {
        const error = payload.error as { message?: string } | undefined;
        throw new ProviderError(
          `Anthropic stream error: ${error?.message ?? data}`,
        );
      }
      case "message_start": {
        const message = payload.message as
          | { usage?: { input_tokens?: number } }
          | undefined;
        if (typeof message?.usage?.input_tokens === "number") {
          inputTokens = message.usage.input_tokens;
          sawUsage = true;
        }
        return;
      }
      case "content_block_start": {
        const index = payload.index as number;
        const block = payload.content_block as
          | { type?: string; id?: string; name?: string }
          | undefined;
        if (
          block?.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          blocks.set(index, { id: block.id, name: block.name, json: "" });
        }
        return;
      }
      case "content_block_delta": {
        const index = payload.index as number;
        const delta = payload.delta as
          | { type?: string; text?: string; partial_json?: string }
          | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          pendingEvents.push({ type: "text-delta", text: delta.text });
        } else if (
          delta?.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          const block = blocks.get(index);
          if (block) block.json += delta.partial_json;
        }
        // Unknown delta types (e.g. thinking_delta) skipped silently.
        return;
      }
      case "content_block_stop": {
        const index = payload.index as number;
        const block = blocks.get(index);
        if (block) {
          blocks.delete(index);
          let input: Json;
          if (block.json.trim() === "") {
            input = {}; // the first input_json_delta is often ""
          } else {
            try {
              input = JSON.parse(block.json) as Json;
            } catch (err) {
              // Deferred: thrown after the stream ends UNLESS stop_reason
              // turns out to be max_tokens (truncated input — drop the call).
              toolInputError = new ProviderError(
                `Anthropic stream sent unparseable tool input for "${block.name}"`,
                { cause: err },
              );
              return;
            }
          }
          pendingEvents.push({
            type: "tool-call",
            id: block.id,
            name: block.name,
            input,
          });
        }
        return;
      }
      case "message_delta": {
        const delta = payload.delta as
          | { stop_reason?: string | null }
          | undefined;
        if (typeof delta?.stop_reason === "string") {
          stopReason = delta.stop_reason;
        }
        const usage = payload.usage as { output_tokens?: number } | undefined;
        if (typeof usage?.output_tokens === "number") {
          outputTokens = usage.output_tokens;
          sawUsage = true;
        }
        return;
      }
      case "message_stop": {
        sawMessageStop = true;
        return;
      }
      default:
        // ping and any future event types: skip silently.
        return;
    }
  }

  function processEventBlock(block: string): void {
    let eventName: string | null = null;
    const dataLines: string[] = [];
    for (const rawLine of block.split(/\r?\n/)) {
      if (rawLine === "" || rawLine.startsWith(":")) continue; // keep-alive
      const colon = rawLine.indexOf(":");
      if (colon === -1) continue;
      const field = rawLine.slice(0, colon);
      let value = rawLine.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value;
      else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length === 0) return;
    parseData(eventName, dataLines.join("\n"));
  }

  function drainBuffer(flush: boolean): void {
    // Events are separated by blank lines (\n\n, tolerating \r\n\r\n).
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (block.trim() !== "") processEventBlock(block);
    }
    if (flush && buffer.trim() !== "") {
      processEventBlock(buffer);
      buffer = "";
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drainBuffer(false);
      while (pendingEvents.length > 0) {
        yield pendingEvents.shift()!;
      }
      if (sawMessageStop) break;
    }
    buffer += decoder.decode();
    drainBuffer(true);
    while (pendingEvents.length > 0) {
      yield pendingEvents.shift()!;
    }
    if (!sawMessageStop && stopReason === null) {
      throw new ProviderError(
        "Anthropic stream ended before the message completed",
      );
    }
    const mappedStopReason = mapStopReason(stopReason);
    if (toolInputError !== null && mappedStopReason !== "max-tokens") {
      throw toolInputError;
    }
    yield {
      type: "done",
      stopReason: mappedStopReason,
      ...(sawUsage ? { usage: { inputTokens, outputTokens } } : {}),
    };
  } finally {
    // Iterator cleanup: release the connection on abort/early-return too.
    try {
      await reader.cancel();
    } catch {
      // stream already errored or closed
    }
  }
}
