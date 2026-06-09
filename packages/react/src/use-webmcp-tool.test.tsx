import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configure,
  getRegisteredTool,
  getRegisteredTools,
  tool,
} from "webmcp-kit";
import {
  useRegisteredTools,
  useWebMCPForms,
  useWebMCPTool,
} from "./use-webmcp-tool.js";

afterEach(() => {
  cleanup();
  for (const t of getRegisteredTools()) t.unregister();
  document.body.innerHTML = "";
  // Restore the deny-by-default confirm behavior for tests that set a handler.
  configure({ confirmHandler: () => false });
});

describe("useWebMCPTool", () => {
  it("registers the tool on mount and returns a working handle", async () => {
    const { result } = renderHook(() =>
      useWebMCPTool("greet", {
        description: "Greets someone",
        run: () => "hello",
      }),
    );

    expect(result.current).not.toBeNull();
    expect(result.current!.name).toBe("greet");
    expect(getRegisteredTool("greet")).toBe(result.current);

    const res = await result.current!.execute({});
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toBe("hello");
  });

  it("unregisters on unmount and rejects further execution", async () => {
    const { result, unmount } = renderHook(() =>
      useWebMCPTool("ephemeral", {
        description: "Short-lived",
        run: () => "alive",
      }),
    );
    const handle = result.current!;
    expect(getRegisteredTool("ephemeral")).toBe(handle);

    unmount();

    expect(getRegisteredTool("ephemeral")).toBeUndefined();
    expect(handle.unregistered).toBe(true);
    const res = await handle.execute({});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("no longer registered");
  });

  it("run sees the latest state without re-registering", async () => {
    const { result } = renderHook(() => {
      const [count, setCount] = useState(0);
      const handle = useWebMCPTool("counter", {
        description: "Reads the current count",
        run: () => ({ count }),
      });
      return { handle, setCount };
    });
    const first = result.current.handle!;

    let res = await first.execute({});
    expect(res.structuredContent).toEqual({ count: 0 });

    act(() => {
      result.current.setCount(5);
    });

    // Same registration (no churn), but execution reflects the new state.
    expect(result.current.handle).toBe(first);
    expect(first.unregistered).toBe(false);
    res = await first.execute({});
    expect(res.structuredContent).toEqual({ count: 5 });
  });

  it("re-registers when deps change and unregisters the old handle", async () => {
    const { result, rerender } = renderHook(
      ({ mode }: { mode: string }) =>
        useWebMCPTool(
          "moded",
          {
            description: `Operates in ${mode} mode`,
            run: () => `mode=${mode}`,
          },
          [mode],
        ),
      { initialProps: { mode: "draft" } },
    );
    const first = result.current!;
    expect(first.descriptor.description).toBe("Operates in draft mode");

    rerender({ mode: "live" });

    const second = result.current!;
    expect(second).not.toBe(first);
    expect(first.unregistered).toBe(true);
    expect(second.descriptor.description).toBe("Operates in live mode");
    expect(getRegisteredTool("moded")).toBe(second);
    const res = await second.execute({});
    expect(res.content[0]!.text).toBe("mode=live");
  });

  it("re-registers under the new name when name changes", () => {
    const { result, rerender } = renderHook(
      ({ name }: { name: string }) =>
        useWebMCPTool(name, {
          description: "Renamable",
          run: () => "ok",
        }),
      { initialProps: { name: "old-name" } },
    );
    const first = result.current!;

    rerender({ name: "new-name" });

    expect(first.unregistered).toBe(true);
    expect(getRegisteredTool("old-name")).toBeUndefined();
    expect(getRegisteredTool("new-name")).toBe(result.current);
    expect(result.current!.name).toBe("new-name");
  });

  it("rejects input that fails schema validation", async () => {
    const { result } = renderHook(() =>
      useWebMCPTool("strict", {
        description: "Requires a qty number",
        inputJsonSchema: {
          type: "object",
          properties: { qty: { type: "number" } },
          required: ["qty"],
        },
        run: ({ qty }) => `qty=${String(qty)}`,
      }),
    );

    const bad = await result.current!.execute({});
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('missing required property "qty"');

    const wrongType = await result.current!.execute({ qty: "three" });
    expect(wrongType.isError).toBe(true);

    const good = await result.current!.execute({ qty: 3 });
    expect(good.isError).toBeUndefined();
    expect(good.content[0]!.text).toBe("qty=3");
  });

  it("confirm reads the latest definition and denial blocks run", async () => {
    const confirmHandler = vi.fn().mockResolvedValue(false);
    configure({ confirmHandler });
    const run = vi.fn(() => "deleted");

    const { result, rerender } = renderHook(
      ({ guarded }: { guarded: boolean }) =>
        useWebMCPTool("delete-account", {
          description: "Deletes the account",
          confirm: guarded ? "Really delete?" : undefined,
          run,
        }),
      { initialProps: { guarded: false } },
    );
    const handle = result.current!;

    // No confirm configured yet: runs without asking.
    let res = await handle.execute({});
    expect(confirmHandler).not.toHaveBeenCalled();
    expect(res.content[0]!.text).toBe("deleted");

    // Enable confirm via re-render — same registration must pick it up.
    rerender({ guarded: true });
    expect(result.current).toBe(handle);

    res = await handle.execute({});
    expect(confirmHandler).toHaveBeenCalledWith(
      "Really delete?",
      "delete-account",
      expect.anything(),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("declined");
    expect(run).toHaveBeenCalledTimes(1); // only the unguarded call ran
  });
});

describe("useWebMCPForms", () => {
  function addForm(parent: HTMLElement, name: string): HTMLFormElement {
    const form = document.createElement("form");
    form.setAttribute("toolname", name);
    form.setAttribute("tooldescription", `Submit the ${name} form`);
    const input = document.createElement("input");
    input.name = "q";
    form.appendChild(input);
    parent.appendChild(form);
    return form;
  }

  it("registers form tools under document on mount, cleans up on unmount", () => {
    addForm(document.body, "search");

    const { unmount } = renderHook(() => useWebMCPForms());
    expect(getRegisteredTool("search")).toBeDefined();

    unmount();
    expect(getRegisteredTool("search")).toBeUndefined();
  });

  it("scopes discovery to the ref element", () => {
    const inside = document.createElement("div");
    document.body.appendChild(inside);
    addForm(inside, "inside-form");
    addForm(document.body, "outside-form");

    const { unmount } = renderHook(() => useWebMCPForms({ current: inside }));
    expect(getRegisteredTool("inside-form")).toBeDefined();
    expect(getRegisteredTool("outside-form")).toBeUndefined();
    unmount();
    expect(getRegisteredTool("inside-form")).toBeUndefined();
  });
});

describe("useRegisteredTools", () => {
  it("tracks registrations and unregistrations from outside React", () => {
    const { result } = renderHook(() => useRegisteredTools());
    expect(result.current).toEqual([]);

    let handle!: ReturnType<typeof tool>;
    act(() => {
      handle = tool("external", {
        description: "Registered outside React",
        run: () => "ok",
      });
    });
    expect(result.current.map((t) => t.name)).toEqual(["external"]);

    act(() => {
      handle.unregister();
    });
    expect(result.current).toEqual([]);
  });

  it("returns a stable snapshot reference when nothing changed", () => {
    act(() => {
      tool("stable", { description: "Stays put", run: () => "ok" });
    });
    const { result, rerender } = renderHook(() => useRegisteredTools());
    const first = result.current;
    expect(first.map((t) => t.name)).toEqual(["stable"]);

    rerender();
    // Same reference: getSnapshot must not return a fresh array each render,
    // or useSyncExternalStore would loop forever.
    expect(result.current).toBe(first);

    act(() => {
      tool("another", { description: "New arrival", run: () => "ok" });
    });
    expect(result.current).not.toBe(first);
    expect(result.current.map((t) => t.name)).toEqual(["stable", "another"]);
  });
});
