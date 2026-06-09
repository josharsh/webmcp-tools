import { tool } from "./tool.js";
import type { JsonSchema, RegisteredTool } from "./types.js";

/**
 * Declarative WebMCP helpers.
 *
 * The declarative API explainer specifies `toolname` / `tooldescription` /
 * `toolautosubmit` attributes on `<form>` elements (and
 * `toolparamdescription` on form controls), with the browser synthesizing a
 * tool from the form's fields. Native support is still rolling out — these
 * helpers synthesize the same tools in userland so declarative forms work in
 * every browser the kit runs in (progressive enhancement).
 *
 * Per the explainer, filling a form does NOT submit it unless the form has
 * the `toolautosubmit` boolean attribute (or `options.autoSubmit` is set):
 * without it the fields are filled, the submit control is focused, and the
 * user is expected to review and submit manually.
 */

const SKIPPED_TYPES = new Set(["submit", "button", "reset", "image", "hidden"]);

interface FieldInfo {
  schema: JsonSchema;
  required: boolean;
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
}

function fieldToSchema(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): FieldInfo | null {
  if (!el.name) return null;
  if (el instanceof HTMLInputElement && SKIPPED_TYPES.has(el.type)) return null;

  // Spec attribute is `toolparamdescription`; `tooldescription` is kept as a
  // back-compat fallback from earlier kit versions.
  const description =
    el.getAttribute("toolparamdescription") ??
    el.getAttribute("tooldescription") ??
    undefined;
  const base: JsonSchema = description ? { description } : {};

  if (el instanceof HTMLSelectElement) {
    const options = [...el.options].map((o) => o.value).filter((v) => v !== "");
    return {
      schema: {
        type: "string",
        ...(options.length && { enum: options }),
        ...base,
      },
      required: el.required,
      element: el,
    };
  }
  if (el instanceof HTMLTextAreaElement) {
    return {
      schema: { type: "string", ...base },
      required: el.required,
      element: el,
    };
  }

  switch (el.type) {
    case "number":
    case "range": {
      const schema: JsonSchema = { type: "number", ...base };
      if (el.min !== "") schema.minimum = Number(el.min);
      if (el.max !== "") schema.maximum = Number(el.max);
      return { schema, required: el.required, element: el };
    }
    case "checkbox":
      return {
        schema: { type: "boolean", ...base },
        required: false,
        element: el,
      };
    default: {
      const schema: JsonSchema = { type: "string", ...base };
      if (el.type === "email") schema.format = "email";
      if (el.type === "url") schema.format = "uri";
      if (el.type === "date") schema.format = "date";
      if (el.maxLength > 0) schema.maxLength = el.maxLength;
      if (el.pattern) schema.pattern = el.pattern;
      return { schema, required: el.required, element: el };
    }
  }
}

export interface FormToolOptions {
  /** Override the tool name (defaults to the form's `toolname` attribute). */
  name?: string;
  /** Override the description (defaults to `tooldescription` attribute). */
  description?: string;
  /** Require user confirmation before the form is submitted. */
  confirm?: boolean | string;
  /**
   * Submit the form automatically after filling it. Defaults to whether the
   * form has the `toolautosubmit` attribute; an explicit boolean here wins
   * over the attribute. Without auto-submit the tool fills the fields,
   * focuses the submit control, and asks the user to review and submit.
   */
  autoSubmit?: boolean;
  /**
   * Called after fields are filled, instead of submitting/focusing.
   * Return a value to send back to the agent.
   */
  onSubmit?: (form: HTMLFormElement) => unknown | Promise<unknown>;
}

/**
 * Synthesize a WebMCP tool from a `<form>` element, mirroring the declarative
 * API: field names/types become the input schema; executing the tool fills
 * the fields and submits the form.
 */
export function formTool(
  form: HTMLFormElement,
  options: FormToolOptions = {},
): RegisteredTool {
  const name = options.name ?? form.getAttribute("toolname") ?? "";
  const description =
    options.description ?? form.getAttribute("tooldescription") ?? "";
  if (!name) {
    throw new Error(
      "webmcp-kit: formTool requires a toolname attribute or options.name",
    );
  }
  if (!description) {
    throw new Error(
      `webmcp-kit: form tool "${name}" requires a tooldescription attribute ` +
        "or options.description",
    );
  }

  const fields = new Map<string, FieldInfo>();
  for (const el of form.elements) {
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ) {
      const info = fieldToSchema(el);
      if (info && !fields.has(el.name)) fields.set(el.name, info);
    }
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [fieldName, info] of fields) {
    properties[fieldName] = info.schema;
    if (info.required) required.push(fieldName);
  }

  return tool(name, {
    description,
    inputJsonSchema: {
      type: "object",
      properties,
      ...(required.length && { required }),
    },
    ...(options.confirm !== undefined && { confirm: options.confirm }),
    async run(args) {
      for (const [fieldName, info] of fields) {
        if (!(fieldName in args)) continue;
        const value = (args as Record<string, unknown>)[fieldName];
        const el = info.element;
        if (el instanceof HTMLInputElement && el.type === "checkbox") {
          el.checked = Boolean(value);
        } else {
          el.value = String(value);
        }
        // Let frameworks (React controlled inputs, etc.) observe the change.
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (options.onSubmit) return options.onSubmit(form);
      const autoSubmit =
        options.autoSubmit ?? form.hasAttribute("toolautosubmit");
      if (autoSubmit) {
        form.requestSubmit();
        return `Submitted form "${name}".`;
      }
      // Per the declarative explainer: without `toolautosubmit` the agent
      // fills the form and the user reviews + submits manually. Focus the
      // submit control to draw attention to it.
      const submitControl = form.querySelector<HTMLElement>(
        "button[type=submit],input[type=submit],button:not([type])",
      );
      submitControl?.focus();
      return (
        `Filled form "${name}". Awaiting user review — the user must ` +
        "submit manually."
      );
    },
  });
}

/**
 * Register tools for every `form[toolname]` under `root` and keep watching
 * for forms added or removed later. Returns a cleanup function.
 */
export function autoRegisterForms(root: ParentNode = document): () => void {
  const handles = new Set<RegisteredTool>();

  // The handle is stored as an expando on the form itself: DOM wrappers seen
  // via querySelectorAll, addedNodes, and mutation targets may be distinct
  // objects for the same underlying element, so an element-keyed Map is not
  // reliable across those code paths.
  const HANDLE = "__webmcpKitFormTool";
  type FormWithHandle = HTMLFormElement & {
    [HANDLE]?: RegisteredTool;
  };

  const register = (form: HTMLFormElement) => {
    const f = form as FormWithHandle;
    if (f[HANDLE] && !f[HANDLE].unregistered) return;
    try {
      const handle = formTool(form);
      f[HANDLE] = handle;
      handles.add(handle);
    } catch (err) {
      console.warn("webmcp-kit: skipping form tool registration:", err);
    }
  };
  const unregister = (form: HTMLFormElement) => {
    const f = form as FormWithHandle;
    const handle = f[HANDLE];
    if (!handle) return;
    handle.unregister();
    handles.delete(handle);
    delete f[HANDLE];
  };

  root
    .querySelectorAll<HTMLFormElement>("form[toolname]")
    .forEach((f) => register(f));

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        const target = mutation.target;
        if (!(target instanceof Element)) continue;
        const form =
          target instanceof HTMLFormElement ? target : target.closest("form");
        if (!form) continue;
        // The tool declaration changed: re-synthesize from scratch.
        // unregister() is synchronous, so the name is free again before
        // formTool() re-registers it.
        unregister(form);
        if (form.hasAttribute("toolname")) register(form);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLFormElement && node.hasAttribute("toolname")) {
          register(node);
        }
        node
          .querySelectorAll?.<HTMLFormElement>("form[toolname]")
          .forEach((f) => register(f));
      }
      for (const node of mutation.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLFormElement) unregister(node);
        node
          .querySelectorAll?.<HTMLFormElement>("form[toolname]")
          .forEach((f) => unregister(f));
      }
    }
  });
  observer.observe(root instanceof Document ? root.documentElement : root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["toolname", "tooldescription", "toolautosubmit"],
  });

  return () => {
    observer.disconnect();
    for (const toolHandle of handles) toolHandle.unregister();
    handles.clear();
  };
}
