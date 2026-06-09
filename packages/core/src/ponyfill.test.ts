import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installPonyfill,
  isPonyfill,
  type PonyfillModelContext,
} from "./ponyfill.js";
import type { ModelContextTool } from "./types.js";

let mc: PonyfillModelContext;

function validTool(
  overrides: Partial<ModelContextTool> = {},
): ModelContextTool {
  return {
    name: "test-tool",
    description: "A test tool",
    inputSchema: { type: "object", properties: {} },
    execute: () => "ok",
    ...overrides,
  };
}

beforeEach(() => {
  delete (document as { modelContext?: unknown }).modelContext;
  const installed = installPonyfill(document);
  if (!isPonyfill(installed)) throw new Error("expected ponyfill");
  mc = installed;
});

afterEach(() => {
  delete (document as { modelContext?: unknown }).modelContext;
  vi.restoreAllMocks();
});

describe("installPonyfill", () => {
  it("installs on document.modelContext and is idempotent", () => {
    expect(document.modelContext).toBe(mc);
    expect(installPonyfill(document)).toBe(mc);
    expect(isPonyfill(mc)).toBe(true);
  });

  it("isPonyfill rejects null/undefined/foreign objects", () => {
    expect(isPonyfill(undefined)).toBe(false);
    expect(isPonyfill(null)).toBe(false);
    expect(isPonyfill({} as never)).toBe(false);
  });
});

describe("registerTool validation", () => {
  it("rejects an empty name", async () => {
    await expect(mc.registerTool(validTool({ name: "" }))).rejects.toThrow(
      TypeError,
    );
    await expect(
      mc.registerTool(validTool({ name: 5 as never })),
    ).rejects.toThrow(/name must be a non-empty string/);
  });

  it("rejects an empty description", async () => {
    await expect(
      mc.registerTool(validTool({ description: "" })),
    ).rejects.toThrow(/description must be a non-empty string/);
  });

  it("rejects a non-function execute", async () => {
    await expect(
      mc.registerTool(validTool({ execute: "run it" as never })),
    ).rejects.toThrow(/execute must be a function/);
  });

  it("rejects a non-object inputSchema", async () => {
    await expect(
      mc.registerTool(validTool({ inputSchema: 42 as never })),
    ).rejects.toThrow(/inputSchema must be an object/);
    await expect(
      mc.registerTool(validTool({ inputSchema: null as never })),
    ).rejects.toThrow(/inputSchema must be an object/);
  });

  it("rejects duplicate names with an InvalidStateError DOMException", async () => {
    await mc.registerTool(validTool());
    const promise = mc.registerTool(validTool());
    await expect(promise).rejects.toBeInstanceOf(DOMException);
    await expect(mc.registerTool(validTool())).rejects.toMatchObject({
      name: "InvalidStateError",
    });
  });

  it("rejected registrations are not listed by getTools", async () => {
    await expect(mc.registerTool(validTool({ name: "" }))).rejects.toThrow();
    expect(mc.getTools()).toHaveLength(0);
  });
});

describe("toolchange events", () => {
  it("fires both the event listener and ontoolchange on register and abort-unregister", async () => {
    const listener = vi.fn();
    const onProp = vi.fn();
    mc.addEventListener("toolchange", listener);
    mc.ontoolchange = onProp;

    const ac = new AbortController();
    await mc.registerTool(validTool(), { signal: ac.signal });
    expect(listener).toHaveBeenCalledTimes(1);
    // happy-dom auto-invokes `on*` properties from dispatchEvent (real
    // browsers do not for plain EventTarget subclasses), so the explicit
    // ontoolchange call in the ponyfill double-fires here. Assert it fired,
    // not an exact count.
    const callsAfterRegister = onProp.mock.calls.length;
    expect(callsAfterRegister).toBeGreaterThanOrEqual(1);
    expect(mc.getTools()).toHaveLength(1);

    ac.abort();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(onProp.mock.calls.length).toBeGreaterThan(callsAfterRegister);
    expect(mc.getTools()).toHaveLength(0);
  });

  it("a pre-aborted signal makes registration a no-op (no event, no tool)", async () => {
    const listener = vi.fn();
    mc.addEventListener("toolchange", listener);
    const ac = new AbortController();
    ac.abort();
    await expect(
      mc.registerTool(validTool(), { signal: ac.signal }),
    ).resolves.toBeUndefined();
    expect(mc.getTools()).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("getTools", () => {
  it("returns descriptors without the execute function", async () => {
    await mc.registerTool(validTool({ name: "a" }));
    await mc.registerTool(validTool({ name: "b", title: "B" }));
    const tools = mc.getTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["a", "b"]);
    for (const t of tools) {
      expect(t).not.toHaveProperty("execute");
      expect(t.description).toBe("A test tool");
      expect(t.inputSchema).toEqual({ type: "object", properties: {} });
    }
  });
});

describe("executeTool", () => {
  it("throws a NotFoundError DOMException for unknown tool names", async () => {
    const promise = mc.executeTool("ghost", {});
    await expect(promise).rejects.toBeInstanceOf(DOMException);
    await expect(mc.executeTool("ghost", {})).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });

  it("invokes execute with the input and a default client", async () => {
    const execute = vi.fn((input: Record<string, unknown>) => ({
      echoed: input,
    }));
    await mc.registerTool(validTool({ name: "echo", execute }));
    const result = await mc.executeTool("echo", { a: 1 });
    expect(result).toEqual({ echoed: { a: 1 } });
    expect(execute).toHaveBeenCalledWith(
      { a: 1 },
      expect.objectContaining({
        requestUserInteraction: expect.any(Function),
      }),
    );
  });

  it("the default client's requestUserInteraction runs the callback", async () => {
    const callback = vi.fn(() => "user-said-yes");
    await mc.registerTool(
      validTool({
        name: "ask",
        execute: (_input, client) => client.requestUserInteraction(callback),
      }),
    );
    await expect(mc.executeTool("ask", {})).resolves.toBe("user-said-yes");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("defaults a missing input to an empty object", async () => {
    const execute = vi.fn(() => "ok");
    await mc.registerTool(validTool({ name: "noargs", execute }));
    await mc.executeTool("noargs", undefined as never);
    expect(execute).toHaveBeenCalledWith({}, expect.anything());
  });
});
