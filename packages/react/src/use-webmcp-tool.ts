import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  autoRegisterForms,
  getRegisteredTools,
  onRegistryChange,
  tool,
} from "webmcp-kit";
import type {
  InferToolArgs,
  RegisteredTool,
  ToolContext,
  ToolDefinition,
  ToolInput,
} from "webmcp-kit";

/**
 * Register a WebMCP tool for the lifetime of the component.
 *
 * - Registers via core `tool()` on mount, unregisters on unmount.
 * - Re-registers when `name` or any entry in `deps` changes (useEffect
 *   semantics). Use `deps` for things that change the tool's *descriptor*
 *   (description, input schema) — not for state read inside `run`.
 * - `run` and `confirm` always see the latest render's props/state without
 *   re-registering: the registered tool is a stable wrapper that routes
 *   execution through a ref holding the most recent definition.
 *
 * Returns the `RegisteredTool` handle, or `null` before the mount effect has
 * run (and after unmount).
 */
export function useWebMCPTool<I extends ToolInput | undefined = undefined>(
  name: string,
  definition: ToolDefinition<I>,
  deps: unknown[] = [],
): RegisteredTool | null {
  const definitionRef = useRef(definition);
  useEffect(() => {
    definitionRef.current = definition;
  });

  const [handle, setHandle] = useState<RegisteredTool | null>(null);

  useEffect(() => {
    // Descriptor fields are snapshotted at registration time (changing them
    // requires a `name`/`deps` change); run/confirm read through the ref so
    // every execution sees the latest closure.
    const def = definitionRef.current;
    const registered = tool<I>(name, {
      description: def.description,
      title: def.title,
      input: def.input,
      inputJsonSchema: def.inputJsonSchema,
      readOnly: def.readOnly,
      untrustedContent: def.untrustedContent,
      exposedTo: def.exposedTo,
      signal: def.signal,
      confirm: (args: InferToolArgs<I>) => {
        const confirm = definitionRef.current.confirm;
        if (confirm === undefined) return false;
        return typeof confirm === "function" ? confirm(args) : confirm;
      },
      run: (args: InferToolArgs<I>, ctx: ToolContext) =>
        definitionRef.current.run(args, ctx),
    });
    setHandle(registered);
    return () => {
      registered.unregister();
      setHandle((current) => (current === registered ? null : current));
    };
    // The caller controls re-registration via `name` and `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, ...deps]);

  return handle;
}

/**
 * Auto-register declarative `form[toolname]` tools for the lifetime of the
 * component. Pass a ref to scope discovery to a subtree; defaults to the
 * whole document. Cleans up (and disconnects the MutationObserver) on
 * unmount.
 */
export function useWebMCPForms(rootRef?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    return autoRegisterForms(rootRef?.current ?? document);
  }, [rootRef]);
}

// ---------------------------------------------------------------------------
// useRegisteredTools — reactive registry snapshot
// ---------------------------------------------------------------------------

const EMPTY_TOOLS: RegisteredTool[] = [];
// `getRegisteredTools()` returns a new array each call; useSyncExternalStore
// needs a stable snapshot reference between registry changes or it would
// re-render forever. Cache the last array and reuse it while contents match.
let cachedTools: RegisteredTool[] = EMPTY_TOOLS;

function getToolsSnapshot(): RegisteredTool[] {
  const next = getRegisteredTools();
  if (
    next.length === cachedTools.length &&
    next.every((t, i) => t === cachedTools[i])
  ) {
    return cachedTools;
  }
  cachedTools = next;
  return next;
}

function subscribeToRegistry(onStoreChange: () => void): () => void {
  return onRegistryChange(onStoreChange);
}

function getServerToolsSnapshot(): RegisteredTool[] {
  return EMPTY_TOOLS;
}

/**
 * Reactive list of every tool currently registered through webmcp-kit
 * (including tools registered outside React). Re-renders on register and
 * unregister events.
 */
export function useRegisteredTools(): RegisteredTool[] {
  return useSyncExternalStore(
    subscribeToRegistry,
    getToolsSnapshot,
    getServerToolsSnapshot,
  );
}
