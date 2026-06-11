import { afterEach, describe, expect, it } from "vitest";
import { initDevtools } from "./devtools.js";
import { tool, configure } from "./tool.js";
import { getRegisteredTools } from "./registry.js";

function panel(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".wmt-dev");
  if (!el) throw new Error("panel not mounted");
  return el;
}

function toolPanel(name: string): HTMLDetailsElement {
  const all = [
    ...document.querySelectorAll<HTMLDetailsElement>(".wmt-dev-tool"),
  ];
  const found = all.find(
    (d) => d.querySelector("strong")?.textContent === name,
  );
  if (!found) throw new Error(`no panel for tool "${name}"`);
  return found;
}

async function runTool(name: string): Promise<HTMLPreElement> {
  const p = toolPanel(name);
  p.querySelector("form")!.dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  // execute path is async — give it two microtask turns
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return p.querySelector<HTMLPreElement>(".wmt-dev-result")!;
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  for (const t of getRegisteredTools()) t.unregister();
  delete (document as { modelContext?: unknown }).modelContext;
  configure({ missingHost: "ponyfill" });
  document.querySelectorAll(".wmt-dev").forEach((n) => n.remove());
  document.getElementById("wmt-dev-styles")?.remove();
});

describe("initDevtools", () => {
  it("mounts, shows empty state, and lists tools live", () => {
    dispose = initDevtools().dispose;
    expect(panel().textContent).toContain("No tools registered");

    const t = tool("dev-a", { description: "first tool", run: () => "ok" });
    expect(panel().textContent).toContain("dev-a");
    expect(panel().textContent).toContain("first tool");
    expect(panel().querySelector(".wmt-dev-count")!.textContent).toBe("1");

    t.unregister();
    expect(panel().textContent).toContain("No tools registered");
  });

  it("renders form fields for flat schemas and badges for annotations", () => {
    dispose = initDevtools().dispose;
    tool("dev-form", {
      description: "flat schema",
      readOnly: true,
      inputJsonSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          qty: { type: "integer" },
          fast: { type: "boolean" },
          size: { type: "string", enum: ["s", "m", "l"] },
        },
        required: ["name"],
      },
      run: (args) => args,
    });

    const p = toolPanel("dev-form");
    expect(p.querySelector('input[name="name"][type="text"]')).toBeTruthy();
    expect(p.querySelector('input[name="qty"][type="number"]')).toBeTruthy();
    expect(p.querySelector('input[name="fast"][type="checkbox"]')).toBeTruthy();
    expect(p.querySelectorAll('select[name="size"] option')).toHaveLength(3);
    expect(p.textContent).toContain("read-only");
    expect(p.querySelector("textarea")).toBeNull();
  });

  it("falls back to a JSON textarea (with schema skeleton) for nested schemas", () => {
    dispose = initDevtools().dispose;
    tool("dev-nested", {
      description: "nested schema",
      inputJsonSchema: {
        type: "object",
        properties: { filters: { type: "object" }, tags: { type: "array" } },
      },
      run: () => "ok",
    });

    const ta = toolPanel("dev-nested").querySelector("textarea");
    expect(ta).toBeTruthy();
    expect(JSON.parse(ta!.value)).toEqual({ filters: {}, tags: [] });
  });

  it("executes through the agent path and pretty-prints the result", async () => {
    dispose = initDevtools().dispose;
    tool("dev-run", {
      description: "echo",
      inputJsonSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
      },
      run: ({ msg }) => ({ echoed: msg }),
    });

    const p = toolPanel("dev-run");
    p.querySelector<HTMLInputElement>('input[name="msg"]')!.value = "hi";
    const result = await runTool("dev-run");
    expect(result.hidden).toBe(false);
    expect(result.textContent).toContain('"echoed": "hi"');
    expect(result.className).toContain("ok");
  });

  it("surfaces validation rejection as an isError result (agent path, not a bypass)", async () => {
    dispose = initDevtools().dispose;
    let ran = false;
    tool("dev-strict", {
      description: "qty must be at least 5",
      inputJsonSchema: {
        type: "object",
        properties: { qty: { type: "number", minimum: 5 } },
        required: ["qty"],
      },
      run: () => {
        ran = true;
        return "should not run";
      },
    });

    const p = toolPanel("dev-strict");
    p.querySelector<HTMLInputElement>('input[name="qty"]')!.value = "2";
    const result = await runTool("dev-strict");
    expect(result.className).toContain("err");
    expect(result.textContent).toContain("minimum 5");
    expect(ran).toBe(false);
  });

  it("rejects invalid JSON textarea input without crashing the panel", async () => {
    dispose = initDevtools().dispose;
    tool("dev-json", {
      description: "nested",
      inputJsonSchema: {
        type: "object",
        properties: { filters: { type: "object" } },
      },
      run: () => "ok",
    });

    const p = toolPanel("dev-json");
    p.querySelector("textarea")!.value = "{not json";
    const result = await runTool("dev-json");
    expect(result.className).toContain("err");
    expect(panel().isConnected).toBe(true);
  });

  it("keeps a tool's panel open across registry changes", () => {
    dispose = initDevtools().dispose;
    tool("dev-keep", { description: "stays open", run: () => "ok" });
    toolPanel("dev-keep").setAttribute("open", "");

    tool("dev-other", { description: "triggers refresh", run: () => "ok" });
    expect(toolPanel("dev-keep").hasAttribute("open")).toBe(true);
    expect(toolPanel("dev-other").hasAttribute("open")).toBe(false);
  });

  it("dispose removes the panel and stops reacting to the registry", () => {
    const handle = initDevtools();
    handle.dispose();
    expect(document.querySelector(".wmt-dev")).toBeNull();
    tool("dev-late", { description: "after dispose", run: () => "ok" });
    expect(document.querySelector(".wmt-dev")).toBeNull();
  });
});
