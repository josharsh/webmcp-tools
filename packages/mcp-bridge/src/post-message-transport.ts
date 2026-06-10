import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export const DEFAULT_CHANNEL = "webmcp-tools-mcp";

/**
 * Which peer produced a message. Both peers can share a single window
 * (extension content scripts, devtools panels, tests), so every envelope is
 * tagged and each transport only consumes messages from the *opposite* side.
 */
type Side = "client" | "server";

interface Envelope {
  channel: string;
  side: Side;
  message: JSONRPCMessage;
}

function matchesEnvelope(
  data: unknown,
  channel: string,
  fromSide: Side,
): data is Envelope {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as Envelope).channel === channel &&
    (data as Envelope).side === fromSide &&
    typeof (data as Envelope).message === "object" &&
    (data as Envelope).message !== null
  );
}

abstract class BasePostMessageTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  protected readonly channel: string;
  /** Side this transport sends as; it consumes the opposite side. */
  protected abstract readonly side: Side;
  private listener: ((event: MessageEvent) => void) | undefined;
  private started = false;
  private closed = false;

  constructor(channel: string | undefined) {
    this.channel = channel ?? DEFAULT_CHANNEL;
  }

  /** Window whose 'message' events this transport consumes. */
  protected abstract listenWindow(): Window;
  /** Origin check for an incoming event. */
  protected abstract acceptsOrigin(event: MessageEvent): boolean;
  /**
   * Peer check, invoked only after the envelope carried a successfully
   * parsed JSON-RPC message. Return false to drop the message (the server
   * side uses this to bind a single peer and reject hijack attempts).
   */
  protected acceptsPeer(_event: MessageEvent): boolean {
    return true;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error(
        "PostMessageTransport already started (the MCP SDK calls start() inside connect())",
      );
    }
    this.started = true;
    const otherSide: Side = this.side === "client" ? "server" : "client";
    this.listener = (event: MessageEvent) => {
      if (!this.acceptsOrigin(event)) return;
      if (!matchesEnvelope(event.data, this.channel, otherSide)) return;
      let message: JSONRPCMessage;
      try {
        message = JSONRPCMessageSchema.parse(event.data.message);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // Only a valid JSON-RPC message may bind/match the peer.
      if (!this.acceptsPeer(event)) return;
      this.onmessage?.(message);
    };
    this.listenWindow().addEventListener(
      "message",
      this.listener as EventListener,
    );
  }

  protected wrap(message: JSONRPCMessage): Envelope {
    return { channel: this.channel, side: this.side, message };
  }

  abstract send(message: JSONRPCMessage): Promise<void>;

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.listener) {
      this.listenWindow().removeEventListener(
        "message",
        this.listener as EventListener,
      );
      this.listener = undefined;
    }
    this.onclose?.();
  }
}

// ---------------------------------------------------------------------------
// Server transport — lives in the page, accepts a connecting agent.
// ---------------------------------------------------------------------------

export interface PostMessageServerTransportOptions {
  /** Window to listen on. Default: the global `window`. */
  window?: Window;
  /**
   * Origins allowed to talk to this server. Required and must be non-empty —
   * pass `["*"]` explicitly (and knowingly) to accept any origin.
   */
  allowedOrigins: string[];
  /** Envelope channel. Default: "webmcp-tools-mcp". */
  channel?: string;
}

/**
 * MCP transport that serves the page's tools over `window.postMessage`.
 * Validates `event.origin` against `allowedOrigins`, binds exactly one peer
 * — the {source, origin} of the first valid JSON-RPC message — and replies
 * via that source targeted at its origin (never a wildcard when a concrete
 * origin is known). Messages from any other source/origin after binding are
 * ignored.
 */
export class PostMessageServerTransport extends BasePostMessageTransport {
  protected readonly side: Side = "server";
  private readonly win: Window;
  private readonly allowedOrigins: string[];
  private peer: { source: Window; origin: string } | undefined;
  private warnedAboutPeerMismatch = false;

  constructor(options: PostMessageServerTransportOptions) {
    super(options.channel);
    if (!options.allowedOrigins || options.allowedOrigins.length === 0) {
      throw new Error(
        "PostMessageServerTransport: allowedOrigins is required. " +
          'Pass concrete origins, or ["*"] to explicitly accept any origin.',
      );
    }
    this.win = options.window ?? globalThis.window;
    this.allowedOrigins = options.allowedOrigins;
  }

  /**
   * Origin of the bound peer, set once its first valid JSON-RPC message
   * arrives. The bridge server uses this to enforce per-tool `exposedTo`.
   */
  get peerOrigin(): string | undefined {
    return this.peer?.origin;
  }

  protected listenWindow(): Window {
    return this.win;
  }

  protected acceptsOrigin(event: MessageEvent): boolean {
    return (
      this.allowedOrigins.includes(event.origin) ||
      this.allowedOrigins.includes("*")
    );
  }

  protected override acceptsPeer(event: MessageEvent): boolean {
    const source = (event.source ?? this.win) as Window;
    if (!this.peer) {
      // First valid JSON-RPC message binds the session to this peer.
      this.peer = { source, origin: event.origin };
      return true;
    }
    if (this.peer.source === source && this.peer.origin === event.origin) {
      return true;
    }
    if (!this.warnedAboutPeerMismatch) {
      this.warnedAboutPeerMismatch = true;
      console.warn(
        "PostMessageServerTransport: ignoring message from a different " +
          "source/origin than the established session peer",
      );
    }
    return false;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.peer) {
      throw new Error(
        "PostMessageServerTransport: cannot send before a client message was received",
      );
    }
    // An empty origin means an opaque origin (e.g. sandboxed iframe) — "*" is
    // the only way to reach it. Otherwise target the captured origin exactly.
    const targetOrigin = this.peer.origin === "" ? "*" : this.peer.origin;
    this.peer.source.postMessage(this.wrap(message), targetOrigin);
  }
}

// ---------------------------------------------------------------------------
// Client transport — extension content script / iframe agent connecting in.
// ---------------------------------------------------------------------------

export interface PostMessageClientTransportOptions {
  /** Window hosting the WebMCP server (e.g. the page window or an iframe). */
  target: Window;
  /** Exact origin of the target window. Use "*" only for opaque origins. */
  targetOrigin: string;
  /** Envelope channel. Must match the server's. Default: "webmcp-tools-mcp". */
  channel?: string;
}

/**
 * MCP client transport that connects to a `PostMessageServerTransport` in
 * another (or the same) window. Sends to `target` with the exact
 * `targetOrigin` and only consumes replies arriving from that origin.
 */
export class PostMessageClientTransport extends BasePostMessageTransport {
  protected readonly side: Side = "client";
  private readonly target: Window;
  private readonly targetOrigin: string;

  constructor(options: PostMessageClientTransportOptions) {
    super(options.channel);
    if (!options.targetOrigin) {
      throw new Error("PostMessageClientTransport: targetOrigin is required");
    }
    this.target = options.target;
    this.targetOrigin = options.targetOrigin;
  }

  protected listenWindow(): Window {
    // Replies from the server arrive on the window running this client.
    return globalThis.window;
  }

  protected acceptsOrigin(event: MessageEvent): boolean {
    return this.targetOrigin === "*" || event.origin === this.targetOrigin;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.target.postMessage(this.wrap(message), this.targetOrigin);
  }
}
