import {
  getRegisteredTool,
  getRegisteredTools,
  onRegistryChange,
} from "./registry.js";
import { isPonyfill } from "./ponyfill.js";
import type { JsonSchema, RegisteredTool, ToolResult } from "./types.js";

/**
 * Dev-mode tool inspector panel (`webmcp-tools/devtools`).
 *
 * A zero-dependency floating panel that lists the page's registered tools
 * live, renders an input form from each tool's JSON Schema, and executes
 * through the same path an agent uses — validation, confirm gates and
 * result normalization included. Import only in development:
 *
 * ```ts
 * if (import.meta.env.DEV) {
 *   const { initDevtools } = await import("webmcp-tools/devtools");
 *   initDevtools();
 * }
 * ```
 */

export interface DevtoolsOptions {
  /** Corner to dock the panel in. Default: "bottom-left". */
  position?: "bottom-left" | "bottom-right";
}

export interface DevtoolsHandle {
  /** Remove the panel and stop listening to registry changes. */
  dispose(): void;
}

const STYLE_ID = "wmt-dev-styles";

const CSS = `
.wmt-dev{position:fixed;z-index:2147483000;width:340px;max-height:70vh;display:flex;flex-direction:column;background:#14161c;color:#dcdfe6;border:1px solid #2a2f3a;border-radius:10px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 12px 40px rgba(0,0,0,.45)}
.wmt-dev[data-pos=bottom-left]{left:14px;bottom:14px}
.wmt-dev[data-pos=bottom-right]{right:14px;bottom:14px}
.wmt-dev-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #2a2f3a;cursor:pointer;user-select:none}
.wmt-dev-head strong{font-weight:600}
.wmt-dev-count{margin-left:auto;background:#222733;border-radius:999px;padding:0 8px}
.wmt-dev-body{overflow-y:auto;padding:6px}
.wmt-dev[data-collapsed=true] .wmt-dev-body{display:none}
.wmt-dev-tool{border:1px solid #232836;border-radius:8px;margin:6px;background:#171a22}
.wmt-dev-tool>summary{padding:7px 10px;cursor:pointer;list-style:none;display:flex;gap:6px;align-items:center}
.wmt-dev-tool>summary::-webkit-details-marker{display:none}
.wmt-dev-badge{font-size:10px;border-radius:4px;padding:0 5px;background:#26456b}
.wmt-dev-badge.ro{background:#2c5e3f}
.wmt-dev-badge.uc{background:#6b4a26}
.wmt-dev-desc{padding:0 10px 6px;color:#9aa3b5}
.wmt-dev-form{display:flex;flex-direction:column;gap:6px;padding:0 10px 10px}
.wmt-dev-field{display:flex;flex-direction:column;gap:2px}
.wmt-dev-field label{color:#9aa3b5}
.wmt-dev-field .req{color:#e0707a}
.wmt-dev input[type=text],.wmt-dev input[type=number],.wmt-dev select,.wmt-dev textarea{background:#0e1015;border:1px solid #2a2f3a;border-radius:6px;color:#dcdfe6;padding:5px 7px;font:inherit}
.wmt-dev textarea{min-height:72px;resize:vertical}
.wmt-dev-run{align-self:flex-start;background:#2451b3;border:1px solid #2e62d9;color:#fff;border-radius:6px;padding:5px 14px;cursor:pointer;font:inherit}
.wmt-dev-run:disabled{opacity:.5;cursor:default}
.wmt-dev-result{margin:0 10px 10px;padding:8px;border-radius:6px;background:#0e1015;border:1px solid #2a2f3a;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow-y:auto}
.wmt-dev-result.err{border-color:#7a2e35;color:#f0a0a8}
.wmt-dev-result.ok{border-color:#2c5e3f}
.wmt-dev-meta{color:#6b7384;padding:0 10px 8px}
.wmt-dev-empty{padding:14px;color:#6b7384;text-align:center}
`;

interface FieldSpec {
  name: string;
  schema: JsonSchema;
  required: boolean;
}

/** Flat object schemas (string/number/boolean/enum props) get real fields. */
function flatFields(schema: JsonSchema | undefined): FieldSpec[] | null {
  if (!schema || schema.type !== "object") return null;
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  if (!props) return null;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const fields: FieldSpec[] = [];
  for (const [name, child] of Object.entries(props)) {
    const t = Array.isArray(child.type) ? child.type[0] : child.type;
    if (
      t !== "string" &&
      t !== "number" &&
      t !== "integer" &&
      t !== "boolean"
    ) {
      return null; // nested/complex → JSON textarea fallback
    }
    fields.push({ name, schema: child, required: required.includes(name) });
  }
  return fields;
}

/** Skeleton JSON for the textarea fallback, derived from the schema. */
function skeleton(schema: JsonSchema | undefined): string {
  const props = (schema?.properties ?? {}) as Record<string, JsonSchema>;
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const t = Array.isArray(v.type) ? v.type[0] : v.type;
    obj[k] =
      t === "number" || t === "integer"
        ? 0
        : t === "boolean"
          ? false
          : t === "array"
            ? []
            : t === "object"
              ? {}
              : "";
  }
  return JSON.stringify(obj, null, 2);
}

/** Execute through the agent path: ponyfill executeTool, else kit handle. */
async function executeAsAgent(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const ctx = document.modelContext;
  if (isPonyfill(ctx)) {
    return (await ctx.executeTool(name, input)) as ToolResult;
  }
  const handle = getRegisteredTool(name);
  if (!handle) throw new Error(`Tool "${name}" is not registered`);
  return handle.execute(input);
}

function renderTool(tool: RegisteredTool): HTMLElement {
  const details = document.createElement("details");
  details.className = "wmt-dev-tool";

  const summary = document.createElement("summary");
  const title = document.createElement("strong");
  title.textContent = tool.name;
  summary.appendChild(title);
  const ann = tool.descriptor.annotations;
  if (ann?.readOnlyHint) {
    const b = document.createElement("span");
    b.className = "wmt-dev-badge ro";
    b.textContent = "read-only";
    summary.appendChild(b);
  }
  if (ann?.untrustedContentHint) {
    const b = document.createElement("span");
    b.className = "wmt-dev-badge uc";
    b.textContent = "untrusted";
    summary.appendChild(b);
  }
  details.appendChild(summary);

  const desc = document.createElement("div");
  desc.className = "wmt-dev-desc";
  desc.textContent = tool.descriptor.description;
  details.appendChild(desc);

  const form = document.createElement("form");
  form.className = "wmt-dev-form";

  const fields = flatFields(tool.descriptor.inputSchema);
  let collect: () => Record<string, unknown>;

  if (fields && fields.length > 0) {
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    for (const f of fields) {
      const wrap = document.createElement("div");
      wrap.className = "wmt-dev-field";
      const label = document.createElement("label");
      label.textContent = f.name;
      if (f.required) {
        const req = document.createElement("span");
        req.className = "req";
        req.textContent = " *";
        label.appendChild(req);
      }
      wrap.appendChild(label);

      const t = Array.isArray(f.schema.type) ? f.schema.type[0] : f.schema.type;
      let el: HTMLInputElement | HTMLSelectElement;
      if (Array.isArray(f.schema.enum)) {
        el = document.createElement("select");
        for (const v of f.schema.enum) {
          const opt = document.createElement("option");
          opt.value = String(v);
          opt.textContent = String(v);
          el.appendChild(opt);
        }
      } else if (t === "boolean") {
        el = document.createElement("input");
        el.type = "checkbox";
      } else if (t === "number" || t === "integer") {
        el = document.createElement("input");
        el.type = "number";
        el.step = t === "integer" ? "1" : "any";
      } else {
        el = document.createElement("input");
        el.type = "text";
      }
      el.name = f.name;
      wrap.appendChild(el);
      form.appendChild(wrap);
      inputs.set(f.name, el);
    }
    collect = () => {
      const out: Record<string, unknown> = {};
      for (const f of fields) {
        const el = inputs.get(f.name)!;
        const t = Array.isArray(f.schema.type)
          ? f.schema.type[0]
          : f.schema.type;
        if (el instanceof HTMLInputElement && el.type === "checkbox") {
          out[f.name] = el.checked;
        } else if (el.value === "" && !f.required) {
          continue; // omit empty optional fields
        } else if (t === "number" || t === "integer") {
          out[f.name] = Number(el.value);
        } else {
          out[f.name] = el.value;
        }
      }
      return out;
    };
  } else {
    const ta = document.createElement("textarea");
    ta.value = skeleton(tool.descriptor.inputSchema);
    ta.spellcheck = false;
    form.appendChild(ta);
    collect = () => JSON.parse(ta.value) as Record<string, unknown>;
  }

  const run = document.createElement("button");
  run.type = "submit";
  run.className = "wmt-dev-run";
  run.textContent = "Run";
  form.appendChild(run);
  details.appendChild(form);

  const meta = document.createElement("div");
  meta.className = "wmt-dev-meta";
  const result = document.createElement("pre");
  result.className = "wmt-dev-result";
  result.hidden = true;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      run.disabled = true;
      const started = performance.now();
      try {
        const res = await executeAsAgent(tool.name, collect());
        result.textContent = JSON.stringify(res, null, 2);
        result.className = `wmt-dev-result ${res.isError ? "err" : "ok"}`;
      } catch (err) {
        result.textContent = String(err);
        result.className = "wmt-dev-result err";
      }
      meta.textContent = `${Math.round(performance.now() - started)} ms`;
      result.hidden = false;
      run.disabled = false;
    })();
  });

  details.appendChild(result);
  details.appendChild(meta);
  return details;
}

/** Mount the inspector panel. Returns a handle to remove it. */
export function initDevtools(options: DevtoolsOptions = {}): DevtoolsHandle {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const root = document.createElement("div");
  root.className = "wmt-dev";
  root.dataset.pos = options.position ?? "bottom-left";
  root.dataset.collapsed = "false";

  const head = document.createElement("div");
  head.className = "wmt-dev-head";
  const title = document.createElement("strong");
  title.textContent = "webmcp-tools";
  const count = document.createElement("span");
  count.className = "wmt-dev-count";
  head.appendChild(title);
  head.appendChild(count);
  head.addEventListener("click", () => {
    root.dataset.collapsed =
      root.dataset.collapsed === "true" ? "false" : "true";
  });
  root.appendChild(head);

  const body = document.createElement("div");
  body.className = "wmt-dev-body";
  root.appendChild(body);

  function refresh(): void {
    const tools = getRegisteredTools();
    count.textContent = String(tools.length);
    // Keep panels open across registry changes (re-registration churn).
    const open = new Set(
      [...body.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
        (d) => d.querySelector("strong")?.textContent ?? "",
      ),
    );
    body.replaceChildren();
    if (tools.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wmt-dev-empty";
      empty.textContent = "No tools registered";
      body.appendChild(empty);
      return;
    }
    for (const tool of tools) {
      const el = renderTool(tool);
      if (open.has(tool.name)) el.setAttribute("open", "");
      body.appendChild(el);
    }
  }

  refresh();
  const unsubscribe = onRegistryChange(refresh);
  document.body.appendChild(root);

  return {
    dispose() {
      unsubscribe();
      root.remove();
    },
  };
}
