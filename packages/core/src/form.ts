import { tool } from "./tool.js";
import type { JsonSchema, RegisteredTool } from "./types.js";

/**
 * Declarative WebMCP helpers.
 *
 * The declarative API explainer specifies `toolname` / `tooldescription`
 * attributes on `<form>` elements, with the browser synthesizing a tool from
 * the form's fields. Native support is still rolling out — these helpers
 * synthesize the same tools in userland so declarative forms work in every
 * browser the kit runs in (progressive enhancement).
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

  const description = el.getAttribute("tooldescription") ?? undefined;
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
   * Called after fields are filled, instead of `form.requestSubmit()`.
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
      form.requestSubmit();
      return `Submitted form "${name}".`;
    },
  });
}

/**
 * Register tools for every `form[toolname]` under `root` and keep watching
 * for forms added or removed later. Returns a cleanup function.
 */
export function autoRegisterForms(root: ParentNode = document): () => void {
  const registered = new Map<HTMLFormElement, RegisteredTool>();

  const register = (form: HTMLFormElement) => {
    if (registered.has(form)) return;
    try {
      registered.set(form, formTool(form));
    } catch (err) {
      console.warn("webmcp-kit: skipping form tool registration:", err);
    }
  };
  const unregister = (form: HTMLFormElement) => {
    registered.get(form)?.unregister();
    registered.delete(form);
  };

  root
    .querySelectorAll<HTMLFormElement>("form[toolname]")
    .forEach((f) => register(f));

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
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
  });

  return () => {
    observer.disconnect();
    for (const toolHandle of registered.values()) toolHandle.unregister();
    registered.clear();
  };
}
