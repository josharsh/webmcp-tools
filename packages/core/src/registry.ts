import type {
  RegisteredTool,
  RegistryEvent,
  RegistryListener,
} from "./types.js";

/**
 * Kit-level registry of tools registered through `tool()`.
 *
 * The native `document.modelContext` does not expose tool enumeration to page
 * script, so this registry is the source of truth for the MCP bridge,
 * devtools, and framework integrations.
 */
const tools = new Map<string, RegisteredTool>();
const listeners = new Set<RegistryListener>();

function emit(event: RegistryEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      // A misbehaving listener must not break tool registration.
      console.error("webmcp-kit: registry listener threw", err);
    }
  }
}

export function registryAdd(toolHandle: RegisteredTool): void {
  tools.set(toolHandle.name, toolHandle);
  emit({ type: "register", tool: toolHandle });
}

export function registryRemove(toolHandle: RegisteredTool): void {
  if (tools.get(toolHandle.name) === toolHandle) {
    tools.delete(toolHandle.name);
    emit({ type: "unregister", tool: toolHandle });
  }
}

export function registryHas(name: string): boolean {
  return tools.has(name);
}

/** All tools currently registered through webmcp-kit. */
export function getRegisteredTools(): RegisteredTool[] {
  return [...tools.values()];
}

/** Look up a registered tool by name. */
export function getRegisteredTool(name: string): RegisteredTool | undefined {
  return tools.get(name);
}

/** Subscribe to register/unregister events. Returns an unsubscribe fn. */
export function onRegistryChange(listener: RegistryListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
