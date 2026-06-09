import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure, getRegisteredTool, getRegisteredTools } from "webmcp-kit";
import { registeredTools, registerTool, webmcpTool } from "./webmcp-tool.js";

let confirmAnswer = true;
const confirmHandler = vi.fn(() => confirmAnswer);

beforeEach(() => {
  confirmAnswer = true;
  confirmHandler.mockClear();
  configure({ confirmHandler });
});

afterEach(() => {
  for (const t of getRegisteredTools()) t.unregister();
});

describe("webmcpTool action", () => {
  it("registers the tool on create and executes it", async () => {
    const action = webmcpTool(undefined, {
      name: "greet",
      description: "Greets",
      run: () => "hello",
    });

    const handle = getRegisteredTool("greet");
    expect(handle).toBeDefined();
    const result = await handle!.execute({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("hello");
    action.destroy();
  });

  it("accepts a real DOM node (lifecycle-only, node unused)", () => {
    const node = document.createElement("div");
    const action = webmcpTool(node, {
      name: "with-node",
      description: "Attached to an element",
      run: () => "ok",
    });
    expect(getRegisteredTool("with-node")).toBeDefined();
    action.destroy();
    expect(getRegisteredTool("with-node")).toBeUndefined();
  });

  it("throws when a tool with the same name is already registered", () => {
    const action = webmcpTool(undefined, {
      name: "dup",
      description: "First",
      run: () => "a",
    });
    expect(() =>
      webmcpTool(undefined, {
        name: "dup",
        description: "Second",
        run: () => "b",
      }),
    ).toThrow(/already registered/);
    action.destroy();
  });

  it("routes the latest run through update() without re-registering", async () => {
    const action = webmcpTool(undefined, {
      name: "counter",
      description: "Counts",
      run: () => "v1",
    });
    const before = getRegisteredTool("counter");

    action.update({
      name: "counter",
      description: "Counts",
      run: () => "v2",
    });

    const after = getRegisteredTool("counter");
    expect(after).toBe(before); // same registration, not re-registered
    const result = await after!.execute({});
    expect(result.content[0]!.text).toBe("v2");
    action.destroy();
  });

  it("re-registers when the name changes on update()", async () => {
    const action = webmcpTool(undefined, {
      name: "old-name",
      description: "Renameable",
      run: () => "old",
    });
    const oldHandle = getRegisteredTool("old-name")!;

    action.update({
      name: "new-name",
      description: "Renameable",
      run: () => "new",
    });

    expect(getRegisteredTool("old-name")).toBeUndefined();
    expect(oldHandle.unregistered).toBe(true);
    const oldResult = await oldHandle.execute({});
    expect(oldResult.isError).toBe(true);

    const newHandle = getRegisteredTool("new-name");
    expect(newHandle).toBeDefined();
    const result = await newHandle!.execute({});
    expect(result.content[0]!.text).toBe("new");
    action.destroy();
    expect(getRegisteredTool("new-name")).toBeUndefined();
  });

  it("destroy() unregisters and further executes fail", async () => {
    const action = webmcpTool(undefined, {
      name: "ephemeral",
      description: "Short-lived",
      run: () => "alive",
    });
    const handle = getRegisteredTool("ephemeral")!;
    action.destroy();

    expect(getRegisteredTool("ephemeral")).toBeUndefined();
    expect(handle.unregistered).toBe(true);
    const result = await handle.execute({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/no longer registered/);
  });

  it("routes the latest confirm through update(): deny then allow", async () => {
    const run = vi.fn(() => "ran");
    const action = webmcpTool(undefined, {
      name: "guarded",
      description: "Guarded",
      run,
    });
    const handle = getRegisteredTool("guarded")!;

    // Initially no confirm gate: runs without asking.
    await handle.execute({});
    expect(confirmHandler).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);

    // Update adds a confirm gate; user declines.
    action.update({
      name: "guarded",
      description: "Guarded",
      confirm: "Really run?",
      run,
    });
    confirmAnswer = false;
    const denied = await handle.execute({});
    expect(confirmHandler).toHaveBeenCalledWith("Really run?", "guarded", {});
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toMatch(/declined/);
    expect(run).toHaveBeenCalledTimes(1); // run was NOT called again

    // User approves.
    confirmAnswer = true;
    const allowed = await handle.execute({});
    expect(allowed.isError).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    action.destroy();
  });

  it("rejects invalid input via JSON Schema validation without calling run", async () => {
    const run = vi.fn(() => "ok");
    const action = webmcpTool(undefined, {
      name: "validated",
      description: "Validates input",
      input: {
        type: "object",
        properties: { qty: { type: "number" } },
        required: ["qty"],
      },
      run,
    });
    const handle = getRegisteredTool("validated")!;

    const missing = await handle.execute({});
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toMatch(/required property "qty"/);

    const wrongType = await handle.execute({ qty: "three" });
    expect(wrongType.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();

    const valid = await handle.execute({ qty: 3 });
    expect(valid.isError).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    action.destroy();
  });
});

describe("registerTool", () => {
  it("registers via core tool() and unregisters cleanly", async () => {
    const t = registerTool("runes-tool", {
      description: "For $effect users",
      run: () => "from runes",
    });
    expect(getRegisteredTool("runes-tool")).toBe(t);
    const result = await t.execute({});
    expect(result.content[0]!.text).toBe("from runes");

    t.unregister();
    expect(t.unregistered).toBe(true);
    expect(getRegisteredTool("runes-tool")).toBeUndefined();
  });
});

describe("registeredTools store", () => {
  it("emits the current snapshot immediately on subscribe", () => {
    const action = webmcpTool(undefined, {
      name: "pre-existing",
      description: "Already there",
      run: () => "x",
    });
    const seen: string[][] = [];
    const unsubscribe = registeredTools.subscribe((tools) =>
      seen.push(tools.map((t) => t.name)),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("pre-existing");
    unsubscribe();
    action.destroy();
  });

  it("emits on register and unregister, and stops after unsubscribe", () => {
    const seen: string[][] = [];
    const unsubscribe = registeredTools.subscribe((tools) =>
      seen.push(tools.map((t) => t.name)),
    );
    expect(seen).toHaveLength(1); // initial snapshot

    const action = webmcpTool(undefined, {
      name: "store-watched",
      description: "Watched",
      run: () => "x",
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("store-watched");

    action.destroy();
    expect(seen).toHaveLength(3);
    expect(seen[2]).not.toContain("store-watched");

    unsubscribe();
    const after = webmcpTool(undefined, {
      name: "after-unsub",
      description: "Should not emit",
      run: () => "x",
    });
    expect(seen).toHaveLength(3); // no further emissions
    after.destroy();
  });
});
