import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../types.js";
import type { ProviderChatRequest, ProviderEvent } from "../types.js";
import { proxy } from "./anthropic.js";

// proxy() exercises the shared wire implementation without key/browser gates.

function makeRequest(signal?: AbortSignal): ProviderChatRequest {
  return {
    system: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxTokens: 4096,
    signal: signal ?? new AbortController().signal,
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A realistic Anthropic stream: text, then a tool_use block. */
function happyStream(): string {
  return (
    sse("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 10 } },
    }) +
    ": keep-alive comment\n\n" +
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hel" },
    }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "lo" },
    }) +
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu_1", name: "add-to-cart" },
    }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "" },
    }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"sku":"a' },
    }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '-1","qty":2}' },
    }) +
    sse("content_block_stop", { type: "content_block_stop", index: 1 }) +
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 25 },
    }) +
    sse("message_stop", { type: "message_stop" })
  );
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function chunkBytes(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(bytes.slice(i, i + size));
  }
  return chunks;
}

function mockFetchStream(chunks: Uint8Array[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: streamFromChunks(chunks),
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function collect(iterable: AsyncIterable<ProviderEvent>) {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Anthropic SSE wire parser", () => {
  it("parses a complete stream even when events split across tiny chunks", async () => {
    // 7-byte chunks guarantee every event is split across reads.
    mockFetchStream(chunkBytes(happyStream(), 7));
    const provider = proxy({ url: "https://upstream.test" });
    const events = await collect(provider.chat(makeRequest()));

    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      {
        type: "tool-call",
        id: "tu_1",
        name: "add-to-cart",
        input: { sku: "a-1", qty: 2 },
      },
      {
        type: "done",
        stopReason: "tool-use",
        usage: { inputTokens: 10, outputTokens: 25 },
      },
    ]);
  });

  it("survives UTF-8 multi-byte characters split mid-chunk", async () => {
    const text =
      sse("message_start", { type: "message_start", message: {} }) +
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "héllo 🌍 wörld" },
      }) +
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      }) +
      sse("message_stop", { type: "message_stop" });
    // 3-byte chunks split every multi-byte char (é, 🌍, ö are 2-4 bytes).
    mockFetchStream(chunkBytes(text, 3));
    const provider = proxy({ url: "https://upstream.test" });
    const events = await collect(provider.chat(makeRequest()));

    const textOut = events
      .filter((e) => e.type === "text-delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(textOut).toBe("héllo 🌍 wörld");
    expect(events.at(-1)).toMatchObject({ stopReason: "end-turn" });
  });

  it("tolerates CRLF line endings and keep-alive comments", async () => {
    const crlf =
      `event: message_start\r\ndata: ${JSON.stringify({
        type: "message_start",
        message: {},
      })}\r\n\r\n` +
      ": ping\r\n\r\n" +
      `event: content_block_delta\r\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      })}\r\n\r\n` +
      `event: message_delta\r\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      })}\r\n\r\n` +
      `event: message_stop\r\ndata: ${JSON.stringify({ type: "message_stop" })}\r\n\r\n`;
    mockFetchStream(chunkBytes(crlf, 11));
    const provider = proxy({ url: "https://upstream.test" });
    const events = await collect(provider.chat(makeRequest()));
    expect(events).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "done", stopReason: "end-turn" },
    ]);
  });

  it("skips unknown event and delta types (ping, thinking_delta)", async () => {
    const text =
      sse("ping", { type: "ping" }) +
      sse("message_start", { type: "message_start", message: {} }) +
      sse("some_future_event", { type: "some_future_event", payload: 1 }) +
      sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      }) +
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm" },
      }) +
      sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "visible" },
      }) +
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
      }) +
      sse("message_stop", { type: "message_stop" });
    mockFetchStream(chunkBytes(text, 1024));
    const provider = proxy({ url: "https://upstream.test" });
    const events = await collect(provider.chat(makeRequest()));
    expect(events).toEqual([
      { type: "text-delta", text: "visible" },
      { type: "done", stopReason: "end-turn" },
    ]);
  });

  it("parses an empty accumulated tool input as {}", async () => {
    const text =
      sse("message_start", { type: "message_start", message: {} }) +
      sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_2", name: "no-args" },
      }) +
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "" },
      }) +
      sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      }) +
      sse("message_stop", { type: "message_stop" });
    mockFetchStream(chunkBytes(text, 1024));
    const provider = proxy({ url: "https://upstream.test" });
    const events = await collect(provider.chat(makeRequest()));
    expect(events[0]).toEqual({
      type: "tool-call",
      id: "tu_2",
      name: "no-args",
      input: {},
    });
  });

  it("throws ProviderError on malformed data JSON", async () => {
    const text =
      sse("message_start", { type: "message_start", message: {} }) +
      "event: content_block_delta\ndata: {not json!!\n\n";
    mockFetchStream(chunkBytes(text, 1024));
    const provider = proxy({ url: "https://upstream.test" });
    await expect(collect(provider.chat(makeRequest()))).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("throws ProviderError on an SSE error event", async () => {
    const text =
      sse("message_start", { type: "message_start", message: {} }) +
      sse("error", {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      });
    mockFetchStream(chunkBytes(text, 1024));
    const provider = proxy({ url: "https://upstream.test" });
    await expect(collect(provider.chat(makeRequest()))).rejects.toThrow(
      /Overloaded/,
    );
  });

  it("throws ProviderError when the stream ends before the message completes", async () => {
    const text =
      sse("message_start", { type: "message_start", message: {} }) +
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "cut off" },
      });
    mockFetchStream(chunkBytes(text, 1024));
    const provider = proxy({ url: "https://upstream.test" });
    await expect(collect(provider.chat(makeRequest()))).rejects.toThrow(
      /ended before/,
    );
  });

  it("throws ProviderError with status on HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => '{"error":{"message":"rate limited"}}',
      }),
    );
    const provider = proxy({ url: "https://upstream.test" });
    const promise = collect(provider.chat(makeRequest()));
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    await promise.catch((err: ProviderError) => {
      expect(err.status).toBe(429);
      expect(err.message).toContain("rate limited");
    });
  });

  it("rejects when aborted mid-stream", async () => {
    const controller = new AbortController();
    const first = new TextEncoder().encode(
      sse("message_start", { type: "message_start", message: {} }),
    );
    let sentFirst = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        if (!sentFirst) {
          sentFirst = true;
          streamController.enqueue(first);
          return;
        }
        // Hang until the consumer aborts — mimic fetch wiring the signal.
        return new Promise<void>((_, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            ),
          );
        });
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream }),
    );

    const provider = proxy({ url: "https://upstream.test" });
    const iterator = provider
      .chat(makeRequest(controller.signal))
      [Symbol.asyncIterator]();
    setTimeout(() => controller.abort(), 5);
    await expect(
      (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels the underlying stream when the consumer stops early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(happyStream()));
        // never closed — a long-lived connection
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream }),
    );
    const provider = proxy({ url: "https://upstream.test" });
    for await (const event of provider.chat(makeRequest())) {
      if (event.type === "text-delta") break; // early exit
    }
    expect(cancelled).toBe(true);
  });
});
