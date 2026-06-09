import { afterEach, describe, expect, it, vi } from "vitest";
import "./zod.js";
import { z } from "zod";
import { configure, errorResult, normalizeResult, tool } from "./tool.js";
import { getRegisteredTool, getRegisteredTools } from "./registry.js";
import { isPonyfill, type PonyfillModelContext } from "./ponyfill.js";
import type { ModelContextClient, ToolResult } from "./types.js";

function host(): PonyfillModelContext {
  const ctx = document.modelContext;
  if (!isPonyfill(ctx)) throw new Error("expected ponyfill host");
  return ctx;
}

afterEach(() => {
  for (const t of getRegisteredTools()) t.unregister();
  // The ponyfill defines modelContext with configurable: true.
  delete (document as { modelContext?: unknown }).modelContext;
  configure({ missingHost: "ponyfill", confirmHandler: () => false });
  vi.restoreAllMocks();
});

describe("tool() registration", () => {
  it("adds the tool to the registry and installs the ponyfill host", async () => {
    const t = tool("add-to-cart", {
      description: "Add a product to the cart",
      input: z.object({ sku: z.string(), qty: z.number().int() }),
      run: () => "added",
    });
    await t.ready;

    expect(getRegisteredTool("add-to-cart")).toBe(t);
    expect(isPonyfill(document.modelContext)).toBe(true);

    const tools = host().getTools();
    expect(tools).toHaveLength(1);
    const descriptor = tools[0]!;
    expect(descriptor.name).toBe("add-to-cart");
    expect(descriptor.description).toBe("Add a product to the cart");
    expect(descriptor).not.toHaveProperty("execute");

    // Derived JSON Schema from the Zod converter (webmcp-kit/zod side effect).
    const schema = descriptor.inputSchema as {
      type: string;
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.sku?.type).toBe("string");
    expect(schema.properties.qty?.type).toBe("integer");
    expect(schema.required).toEqual(expect.arrayContaining(["sku", "qty"]));
  });

  it("throws on duplicate names", () => {
    tool("dup", { description: "d", run: () => "ok" });
    expect(() => tool("dup", { description: "d", run: () => "ok" })).toThrow(
      /already registered/,
    );
  });

  it("throws on empty name or missing description", () => {
    expect(() => tool("", { description: "d", run: () => "ok" })).toThrow(
      /non-empty/,
    );
    expect(() => tool("no-desc", { description: "", run: () => "ok" })).toThrow(
      /needs a description/,
    );
  });

  it("maps readOnly/untrustedContent to spec annotations", () => {
    const t = tool("annotated", {
      description: "d",
      readOnly: true,
      untrustedContent: true,
      run: () => "ok",
    });
    expect(t.descriptor.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });

    const plain = tool("plain", { description: "d", run: () => "ok" });
    expect(plain.descriptor.annotations).toBeUndefined();
  });

  it("includes title in the descriptor when provided", () => {
    const t = tool("titled", { description: "d", title: "Nice", run: () => 1 });
    expect(t.descriptor.title).toBe("Nice");
  });
});

describe("tool() execute — validation & results", () => {
  it("passes validated, transformed args to run (Zod defaults applied)", async () => {
    const run = vi.fn(() => "done");
    const t = tool("defaults", {
      description: "d",
      input: z.object({ n: z.number().default(7), s: z.string() }),
      run,
    });
    const result = await t.execute({ s: "x" });
    expect(result.isError).toBeUndefined();
    expect(run).toHaveBeenCalledWith(
      { n: 7, s: "x" },
      expect.objectContaining({ rawInput: { s: "x" } }),
    );
  });

  it("returns an isError result (does not throw) on invalid Zod input", async () => {
    const run = vi.fn();
    const t = tool("strict", {
      description: "d",
      input: z.object({ qty: z.number().int() }),
      run,
    });
    const result = await t.execute({ qty: "lots" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Invalid input for tool "strict"/);
    expect(run).not.toHaveBeenCalled();
  });

  it("validates raw JSON Schema inputs via the subset validator", async () => {
    const run = vi.fn(() => "ok");
    const t = tool("raw-schema", {
      description: "d",
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      run,
    });
    const bad = await t.execute({});
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/missing required property "id"/);
    expect(run).not.toHaveBeenCalled();

    const good = await t.execute({ id: "a1" });
    expect(good.isError).toBeUndefined();
    expect(run).toHaveBeenCalledWith({ id: "a1" }, expect.anything());
  });

  it('wraps thrown run() errors as isError "Tool … failed"', async () => {
    const t = tool("boomer", {
      description: "d",
      run: () => {
        throw new Error("boom");
      },
    });
    const result = await t.execute({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Tool "boomer" failed: boom');
  });

  it('normalizes undefined to "ok" and strings to text blocks', async () => {
    const t1 = tool("void", { description: "d", run: () => undefined });
    expect((await t1.execute({})).content).toEqual([
      { type: "text", text: "ok" },
    ]);

    const t2 = tool("stringy", { description: "d", run: () => "hello" });
    expect((await t2.execute({})).content).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("normalizes objects to structuredContent + JSON text", async () => {
    const payload = { ok: true, cartSize: 3 };
    const t = tool("objecty", { description: "d", run: () => payload });
    const result = await t.execute({});
    expect(result.structuredContent).toEqual(payload);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(payload) },
    ]);
  });

  it("passes preformed ToolResult values through untouched", async () => {
    const preformed: ToolResult = {
      content: [{ type: "text", text: "already shaped" }],
    };
    const t = tool("preformed", { description: "d", run: () => preformed });
    expect(await t.execute({})).toBe(preformed);
  });
});

describe("normalizeResult / errorResult", () => {
  it("normalizeResult handles null like undefined", () => {
    expect(normalizeResult(null)).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("errorResult sets isError", () => {
    expect(errorResult("bad")).toEqual({
      content: [{ type: "text", text: "bad" }],
      isError: true,
    });
  });
});

describe("tool() confirm gates", () => {
  it('confirm: true denied by the configured handler returns "User declined"', async () => {
    const handler = vi.fn(() => false);
    configure({ confirmHandler: handler });
    const run = vi.fn();
    const t = tool("guarded", {
      description: "d",
      title: "Guarded Tool",
      confirm: true,
      run,
    });
    const result = await t.execute({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      'User declined to run tool "guarded".',
    );
    expect(handler).toHaveBeenCalledWith(
      'Allow the agent to run "Guarded Tool"?',
      "guarded",
      {},
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("confirm: true approved by the handler runs the tool", async () => {
    configure({ confirmHandler: () => true });
    const t = tool("approved", {
      description: "d",
      confirm: true,
      run: () => "ran",
    });
    const result = await t.execute({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("ran");
  });

  it("confirm: string passes that message to the handler", async () => {
    const handler = vi.fn(() => true);
    configure({ confirmHandler: handler });
    const t = tool("msg", { description: "d", confirm: "Sure?", run: () => 1 });
    await t.execute({});
    expect(handler).toHaveBeenCalledWith("Sure?", "msg", {});
  });

  it("confirm fn returning false skips the handler entirely", async () => {
    const handler = vi.fn(() => false); // would deny if consulted
    configure({ confirmHandler: handler });
    const t = tool("silent", {
      description: "d",
      input: z.object({ qty: z.number() }),
      confirm: ({ qty }) => qty > 5 && `Add ${qty} items?`,
      run: () => "ran",
    });
    const result = await t.execute({ qty: 2 });
    expect(handler).not.toHaveBeenCalled();
    expect(result.content[0]!.text).toBe("ran");
  });

  it("confirm fn returning a string passes it (and args) to the handler", async () => {
    const handler = vi.fn(() => false);
    configure({ confirmHandler: handler });
    const t = tool("dynamic", {
      description: "d",
      input: z.object({ qty: z.number() }),
      confirm: ({ qty }) => qty > 5 && `Add ${qty} items?`,
      run: () => "ran",
    });
    const result = await t.execute({ qty: 9 });
    expect(handler).toHaveBeenCalledWith("Add 9 items?", "dynamic", { qty: 9 });
    expect(result.isError).toBe(true);
  });

  it("routes confirmation through client.requestUserInteraction when provided", async () => {
    const handler = vi.fn(() => true);
    configure({ confirmHandler: handler });
    const client: ModelContextClient = {
      requestUserInteraction: vi.fn(async (cb) => cb()),
    };
    const t = tool("native-confirm", {
      description: "d",
      confirm: true,
      run: () => "ran",
    });
    const result = await t.execute({}, client);
    expect(client.requestUserInteraction).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.content[0]!.text).toBe("ran");
  });

  it("ctx.requestUserInteraction uses the native client when present", async () => {
    const client: ModelContextClient = {
      requestUserInteraction: vi.fn(async (cb) => cb()),
    };
    const t = tool("interactive", {
      description: "d",
      run: (_args, ctx) => ctx.requestUserInteraction(() => "from-user"),
    });
    const viaClient = await t.execute({}, client);
    expect(client.requestUserInteraction).toHaveBeenCalledTimes(1);
    expect(viaClient.content[0]!.text).toBe("from-user");

    // Without a client the callback is invoked directly.
    const direct = await t.execute({});
    expect(direct.content[0]!.text).toBe("from-user");
  });
});

describe("tool() unregister", () => {
  it("removes the tool from registry and host; later execute is an error", async () => {
    const t = tool("temp", { description: "d", run: () => "ok" });
    await t.ready;
    expect(host().getTools()).toHaveLength(1);

    t.unregister();
    expect(t.unregistered).toBe(true);
    expect(getRegisteredTool("temp")).toBeUndefined();
    expect(host().getTools()).toHaveLength(0);

    const result = await t.execute({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      'Tool "temp" is no longer registered.',
    );
  });

  it("is idempotent", () => {
    const t = tool("twice", { description: "d", run: () => "ok" });
    t.unregister();
    expect(() => t.unregister()).not.toThrow();
    expect(t.unregistered).toBe(true);
  });

  it("aborting an external signal unregisters the tool", async () => {
    const ac = new AbortController();
    const t = tool("aborted", {
      description: "d",
      signal: ac.signal,
      run: () => "ok",
    });
    await t.ready;
    expect(host().getTools()).toHaveLength(1);

    ac.abort();
    expect(t.unregistered).toBe(true);
    expect(getRegisteredTool("aborted")).toBeUndefined();
    expect(host().getTools()).toHaveLength(0);
  });

  it("frees the name for re-registration", () => {
    const t = tool("reuse", { description: "d", run: () => 1 });
    t.unregister();
    expect(() =>
      tool("reuse", { description: "d", run: () => 2 }),
    ).not.toThrow();
  });
});

describe("configure missingHost", () => {
  it('"noop": registration succeeds but no host is installed', async () => {
    configure({ missingHost: "noop" });
    expect(document.modelContext).toBeUndefined();

    const t = tool("noop-tool", { description: "d", run: () => "ok" });
    await expect(t.ready).resolves.toBeUndefined();
    expect(document.modelContext).toBeUndefined();
    expect(getRegisteredTool("noop-tool")).toBe(t);

    // Local execution still works (registry-driven bridges rely on this).
    const result = await t.execute({});
    expect(result.content[0]!.text).toBe("ok");
  });

  it('"throw": registration throws and leaves the registry clean', () => {
    configure({ missingHost: "throw" });
    expect(document.modelContext).toBeUndefined();
    expect(() =>
      tool("throw-tool", { description: "d", run: () => "ok" }),
    ).toThrow(/document\.modelContext is not available/);
    expect(getRegisteredTools()).toHaveLength(0);
  });
});
