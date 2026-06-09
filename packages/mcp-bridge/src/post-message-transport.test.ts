import { afterEach, describe, expect, it, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_CHANNEL,
  PostMessageClientTransport,
  PostMessageServerTransport,
} from "./post-message-transport.js";

const ORIGIN = window.location.origin;
const flush = () => new Promise<void>((r) => setTimeout(r, 30));

const ping: JSONRPCMessage = { jsonrpc: "2.0", id: 1, method: "ping" };

let channelCounter = 0;
function nextChannel(): string {
  return `transport-test-${channelCounter++}`;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  vi.restoreAllMocks();
});

async function startedServer(
  allowedOrigins: string[],
  channel: string,
): Promise<PostMessageServerTransport> {
  const transport = new PostMessageServerTransport({ allowedOrigins, channel });
  await transport.start();
  cleanups.push(() => transport.close());
  return transport;
}

function postAsClient(channel: string, message: unknown): void {
  window.postMessage({ channel, side: "client", message }, ORIGIN);
}

describe("PostMessageServerTransport", () => {
  it("requires a non-empty allowedOrigins list", () => {
    expect(
      () =>
        new PostMessageServerTransport({
          allowedOrigins: [],
        }),
    ).toThrow(/allowedOrigins is required/);
    expect(
      () =>
        new PostMessageServerTransport({
          allowedOrigins: undefined,
        } as unknown as {
          allowedOrigins: string[];
        }),
    ).toThrow(/allowedOrigins is required/);
  });

  it("throws if started twice", async () => {
    const transport = await startedServer([ORIGIN], nextChannel());
    await expect(transport.start()).rejects.toThrow(/already started/);
  });

  it("delivers JSON-RPC messages from allowed origins", async () => {
    const channel = nextChannel();
    const transport = await startedServer([ORIGIN], channel);
    const onmessage = vi.fn();
    transport.onmessage = onmessage;

    postAsClient(channel, ping);
    await flush();

    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(onmessage).toHaveBeenCalledWith(ping);
  });

  it("ignores messages from origins not in allowedOrigins", async () => {
    const channel = nextChannel();
    const transport = await startedServer(["https://trusted.example"], channel);
    const onmessage = vi.fn();
    transport.onmessage = onmessage;

    // Synthetic event with a hostile origin.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel, side: "client", message: ping },
        origin: "https://evil.example",
      }),
    );
    // Real postMessage from this window — origin is ORIGIN, also not allowed.
    postAsClient(channel, ping);
    await flush();

    expect(onmessage).not.toHaveBeenCalled();
  });

  it("does not treat '*' as implicitly allowed, but honors an explicit '*'", async () => {
    const channel = nextChannel();
    const strict = await startedServer(["https://trusted.example"], channel);
    const strictMessages = vi.fn();
    strict.onmessage = strictMessages;

    const openChannel = nextChannel();
    const open = await startedServer(["*"], openChannel);
    const openMessages = vi.fn();
    open.onmessage = openMessages;

    postAsClient(channel, ping);
    postAsClient(openChannel, ping);
    await flush();

    expect(strictMessages).not.toHaveBeenCalled();
    expect(openMessages).toHaveBeenCalledWith(ping);
  });

  it("ignores other channels and its own server-side messages", async () => {
    const channel = nextChannel();
    const transport = await startedServer([ORIGIN], channel);
    const onmessage = vi.fn();
    transport.onmessage = onmessage;

    window.postMessage(
      { channel: "other", side: "client", message: ping },
      ORIGIN,
    );
    window.postMessage({ channel, side: "server", message: ping }, ORIGIN);
    window.postMessage("not an envelope", ORIGIN);
    await flush();

    expect(onmessage).not.toHaveBeenCalled();
  });

  it("reports malformed JSON-RPC payloads via onerror without delivering them", async () => {
    const channel = nextChannel();
    const transport = await startedServer([ORIGIN], channel);
    const onmessage = vi.fn();
    const onerror = vi.fn();
    transport.onmessage = onmessage;
    transport.onerror = onerror;

    postAsClient(channel, { not: "json-rpc" });
    await flush();

    expect(onmessage).not.toHaveBeenCalled();
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(onerror.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it("cannot send before a client message captured the peer", async () => {
    const transport = await startedServer([ORIGIN], nextChannel());
    await expect(transport.send(ping)).rejects.toThrow(
      /before a client message/,
    );
  });

  it("a malformed envelope does not bind a peer", async () => {
    const channel = nextChannel();
    const transport = await startedServer([ORIGIN], channel);
    transport.onerror = () => {};

    postAsClient(channel, { not: "json-rpc" });
    await flush();

    expect(transport.peerOrigin).toBeUndefined();
    await expect(transport.send(ping)).rejects.toThrow(
      /before a client message/,
    );
  });

  it("exposes the bound peer origin via the peerOrigin getter", async () => {
    const channel = nextChannel();
    const transport = await startedServer(["https://trusted.example"], channel);
    transport.onmessage = () => {};

    expect(transport.peerOrigin).toBeUndefined();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel, side: "client", message: ping },
        origin: "https://trusted.example",
        source: { postMessage: vi.fn() } as unknown as Window,
      }),
    );
    expect(transport.peerOrigin).toBe("https://trusted.example");
  });

  it("binds once: a second source/origin cannot hijack the session", async () => {
    const channel = nextChannel();
    const transport = await startedServer(
      ["https://trusted.example", "https://also-allowed.example"],
      channel,
    );
    const onmessage = vi.fn();
    transport.onmessage = onmessage;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const firstSource = { postMessage: vi.fn() };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel, side: "client", message: ping },
        origin: "https://trusted.example",
        source: firstSource as unknown as Window,
      }),
    );
    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(transport.peerOrigin).toBe("https://trusted.example");

    // Different origin AND different source: ignored even though allowed.
    const hijacker = { postMessage: vi.fn() };
    const hijackPing: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: 99,
      method: "ping",
    };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel, side: "client", message: hijackPing },
        origin: "https://also-allowed.example",
        source: hijacker as unknown as Window,
      }),
    );
    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(transport.peerOrigin).toBe("https://trusted.example");

    // Same origin, different source window: also ignored (warn only once).
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel, side: "client", message: hijackPing },
        origin: "https://trusted.example",
        source: hijacker as unknown as Window,
      }),
    );
    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // Replies still target the original peer only.
    const reply: JSONRPCMessage = { jsonrpc: "2.0", id: 1, result: {} };
    await transport.send(reply);
    expect(firstSource.postMessage).toHaveBeenCalledTimes(1);
    expect(hijacker.postMessage).not.toHaveBeenCalled();
  });

  it("replies to the captured source targeting the captured origin (no wildcard)", async () => {
    const channel = nextChannel();
    const transport = await startedServer(["https://trusted.example"], channel);
    transport.onmessage = () => {};

    const fakeSource = { postMessage: vi.fn() };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel, side: "client", message: ping },
        origin: "https://trusted.example",
        source: fakeSource as unknown as Window,
      }),
    );

    const reply: JSONRPCMessage = { jsonrpc: "2.0", id: 1, result: {} };
    await transport.send(reply);

    expect(fakeSource.postMessage).toHaveBeenCalledWith(
      { channel, side: "server", message: reply },
      "https://trusted.example",
    );
  });

  it("falls back to '*' only for opaque (empty) captured origins", async () => {
    const channel = nextChannel();
    const transport = await startedServer(["*"], channel);
    transport.onmessage = () => {};

    const fakeSource = { postMessage: vi.fn() };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel, side: "client", message: ping },
        origin: "",
        source: fakeSource as unknown as Window,
      }),
    );

    const reply: JSONRPCMessage = { jsonrpc: "2.0", id: 2, result: {} };
    await transport.send(reply);

    expect(fakeSource.postMessage).toHaveBeenCalledWith(
      { channel, side: "server", message: reply },
      "*",
    );
  });

  it("stops listening after close and fires onclose", async () => {
    const channel = nextChannel();
    const transport = new PostMessageServerTransport({
      allowedOrigins: [ORIGIN],
      channel,
    });
    await transport.start();
    const onmessage = vi.fn();
    const onclose = vi.fn();
    transport.onmessage = onmessage;
    transport.onclose = onclose;

    await transport.close();
    expect(onclose).toHaveBeenCalledTimes(1);

    postAsClient(channel, ping);
    await flush();
    expect(onmessage).not.toHaveBeenCalled();

    // close() is idempotent.
    await transport.close();
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});

describe("PostMessageClientTransport", () => {
  it("requires a targetOrigin", () => {
    expect(
      () =>
        new PostMessageClientTransport({
          target: window,
          targetOrigin: "",
        }),
    ).toThrow(/targetOrigin is required/);
  });

  it("sends client-tagged envelopes to the target with the exact targetOrigin", async () => {
    const transport = new PostMessageClientTransport({
      target: window,
      targetOrigin: ORIGIN,
    });
    await transport.start();
    cleanups.push(() => transport.close());

    const postSpy = vi.spyOn(window, "postMessage");
    await transport.send(ping);

    expect(postSpy).toHaveBeenCalledWith(
      { channel: DEFAULT_CHANNEL, side: "client", message: ping },
      ORIGIN,
    );
  });

  it("only consumes server-side messages, never its own", async () => {
    const channel = nextChannel();
    const transport = new PostMessageClientTransport({
      target: window,
      targetOrigin: ORIGIN,
      channel,
    });
    await transport.start();
    cleanups.push(() => transport.close());
    const onmessage = vi.fn();
    transport.onmessage = onmessage;

    window.postMessage({ channel, side: "client", message: ping }, ORIGIN);
    await flush();
    expect(onmessage).not.toHaveBeenCalled();

    window.postMessage({ channel, side: "server", message: ping }, ORIGIN);
    await flush();
    expect(onmessage).toHaveBeenCalledWith(ping);
  });

  it("ignores server messages arriving from a different origin", async () => {
    const channel = nextChannel();
    const transport = new PostMessageClientTransport({
      target: window,
      targetOrigin: "https://expected.example",
      channel,
    });
    await transport.start();
    cleanups.push(() => transport.close());
    const onmessage = vi.fn();
    transport.onmessage = onmessage;

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel, side: "server", message: ping },
        origin: "https://imposter.example",
      }),
    );
    await flush();
    expect(onmessage).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel, side: "server", message: ping },
        origin: "https://expected.example",
      }),
    );
    await flush();
    expect(onmessage).toHaveBeenCalledWith(ping);
  });
});
