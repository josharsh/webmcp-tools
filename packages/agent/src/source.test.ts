import { afterEach, describe, expect, it, vi } from "vitest";
import { installPonyfill, isPonyfill, tool } from "webmcp-tools";
import type { ModelContext, RegisteredTool } from "webmcp-tools";
import { pageToolSource } from "./source.js";

const handles: RegisteredTool[] = [];
const rawAborts: AbortController[] = [];

function register(
  name: string,
  extra: { title?: string; readOnly?: boolean; exposedTo?: string[] } = {},
): RegisteredTool {
  const handle = tool(name, {
    description: `Test tool ${name}`,
    input: { type: "object", properties: { v: { type: "string" } } },
    run: (args) => ({ echoed: (args.v as string | undefined) ?? null }),
    ...extra,
  });
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.unregister();
  for (const controller of rawAborts.splice(0)) controller.abort();
  vi.restoreAllMocks();
});

const client = {
  requestUserInteraction: <T>(cb: () => T | Promise<T>) =>
    Promise.resolve(cb()),
};

describe("pageToolSource — ponyfill path", () => {
  it("prefers the ponyfill agent surface and lists kit tools", () => {
    installPonyfill(document);
    expect(isPonyfill(document.modelContext)).toBe(true);
    register("src-list", { title: "Lister", readOnly: true });

    const source = pageToolSource();
    const listed = source.list().find((t) => t.name === "src-list");
    expect(listed).toBeDefined();
    expect(listed!.title).toBe("Lister");
    expect(listed!.annotations?.readOnlyHint).toBe(true);
    expect(listed!.inputSchema).toMatchObject({ type: "object" });
  });

  it("executes through the real kit pipeline (validation included)", async () => {
    register("src-exec");
    const source = pageToolSource();

    const ok = await source.execute("src-exec", { v: "hi" }, client);
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toEqual({ echoed: "hi" });

    // Validation failure comes back as an error result, never a throw.
    const bad = await source.execute("src-exec", { v: 42 }, client);
    expect(bad.isError).toBe(true);
  });

  it("normalizes raw registerTool results and sees raw tools", async () => {
    const ctx = document.modelContext!;
    const controller = new AbortController();
    rawAborts.push(controller);
    await ctx.registerTool(
      {
        name: "src-raw",
        description: "Raw spec tool",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ plain: "object" }),
      },
      { signal: controller.signal },
    );
    const source = pageToolSource();
    expect(source.list().some((t) => t.name === "src-raw")).toBe(true);
    const result = await source.execute("src-raw", {}, client);
    expect(result.content[0]!.text).toBe(JSON.stringify({ plain: "object" }));
    expect(result.structuredContent).toEqual({ plain: "object" });
  });

  it("returns an error result for unknown tools instead of throwing", async () => {
    const source = pageToolSource();
    const result = await source.execute("src-nope", {}, client);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("src-nope");
  });

  it("enforces exposedTo for cross-origin agent callers", async () => {
    register("src-exposed", { exposedTo: ["https://allowed.example"] });
    const stranger = pageToolSource({ origin: "https://stranger.example" });
    expect(stranger.list().some((t) => t.name === "src-exposed")).toBe(false);
    const result = await stranger.execute("src-exposed", {}, client);
    expect(result.isError).toBe(true);

    const friend = pageToolSource({ origin: "https://allowed.example" });
    expect(friend.list().some((t) => t.name === "src-exposed")).toBe(true);
  });

  it("notifies subscribers when tools change (mid-conversation refresh)", async () => {
    const source = pageToolSource();
    const onChange = vi.fn();
    const unsubscribe = source.subscribe(onChange);

    register("src-live");
    // Registry events are synchronous; ponyfill toolchange is a microtask.
    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).toHaveBeenCalled();
    expect(source.list().some((t) => t.name === "src-live")).toBe(true);

    onChange.mockClear();
    unsubscribe();
    register("src-after-unsub");
    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("pageToolSource — registry fallback (native-like host)", () => {
  async function withFakeNativeHost(fn: () => void | Promise<void>) {
    const original = document.modelContext;
    const fake = new EventTarget() as unknown as ModelContext;
    (fake as unknown as Record<string, unknown>).registerTool = () =>
      Promise.resolve();
    (fake as unknown as Record<string, unknown>).ontoolchange = null;
    Object.defineProperty(document, "modelContext", {
      value: fake,
      configurable: true,
      writable: false,
    });
    try {
      await fn();
    } finally {
      Object.defineProperty(document, "modelContext", {
        value: original,
        configurable: true,
        writable: false,
      });
    }
  }

  it("falls back to the kit registry when the host is not the ponyfill", async () => {
    await withFakeNativeHost(async () => {
      expect(isPonyfill(document.modelContext)).toBe(false);
      register("src-native");
      const source = pageToolSource();
      expect(source.list().some((t) => t.name === "src-native")).toBe(true);

      const result = await source.execute("src-native", { v: "x" }, client);
      expect(result.structuredContent).toEqual({ echoed: "x" });

      // Unregistered tools disappear from list and execution.
      handles.forEach((h) => h.unregister());
      expect(source.list().some((t) => t.name === "src-native")).toBe(false);
      const gone = await source.execute("src-native", {}, client);
      expect(gone.isError).toBe(true);
    });
  });

  it("notifies subscribers via registry events on the fallback path", async () => {
    await withFakeNativeHost(() => {
      const source = pageToolSource();
      const onChange = vi.fn();
      const unsubscribe = source.subscribe(onChange);
      register("src-native-live");
      expect(onChange).toHaveBeenCalled();
      unsubscribe();
    });
  });
});
