import { useRef, useState } from "react";
import { z } from "zod";
import { useRegisteredTools, useWebMCPTool } from "@webmcp-kit/react";
import {
  errorResult,
  getModelContext,
  getRegisteredTool,
  hasNativeWebMCP,
  isPonyfill,
} from "webmcp-kit";

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([
    { id: 1, text: "Try the simulate panel below", done: false },
  ]);
  const [draft, setDraft] = useState("");

  // Tools close over these refs (not over `todos` directly) so they can be
  // registered once and still always read/write the latest state.
  const todosRef = useRef(todos);
  todosRef.current = todos;
  const nextId = useRef(2);

  function addTodo(text: string): Todo {
    const todo: Todo = { id: nextId.current++, text, done: false };
    setTodos((prev) => [...prev, todo]);
    return todo;
  }

  function completeTodo(id: number): Todo | undefined {
    const found = todosRef.current.find((t) => t.id === id);
    if (found) {
      setTodos((prev) =>
        prev.map((t) => (t.id === id ? { ...t, done: true } : t)),
      );
    }
    return found;
  }

  function deleteTodo(id: number): Todo | undefined {
    const found = todosRef.current.find((t) => t.id === id);
    if (found) setTodos((prev) => prev.filter((t) => t.id !== id));
    return found;
  }

  // --- WebMCP tools -------------------------------------------------------

  useWebMCPTool("add-todo", {
    description: "Add a new todo item to the list.",
    title: "Add todo",
    input: z.object({
      text: z.string().min(1).describe("The todo text to add"),
    }),
    run({ text }) {
      const todo = addTodo(text);
      return { added: todo, count: todosRef.current.length + 1 };
    },
  });

  useWebMCPTool("complete-todo", {
    description: "Mark a todo item as completed, identified by its id.",
    title: "Complete todo",
    input: z.object({
      id: z.number().int().describe("Id of the todo to mark as done"),
    }),
    run({ id }) {
      const found = completeTodo(id);
      if (!found) return errorResult(`No todo with id ${id}.`);
      return `Completed "${found.text}" (id ${id}).`;
    },
  });

  useWebMCPTool("delete-todo", {
    description: "Permanently delete a todo item, identified by its id.",
    title: "Delete todo",
    confirm: true, // human-in-the-loop gate before any destructive action
    input: z.object({
      id: z.number().int().describe("Id of the todo to delete"),
    }),
    run({ id }) {
      const found = deleteTodo(id);
      if (!found) return errorResult(`No todo with id ${id}.`);
      return `Deleted "${found.text}" (id ${id}).`;
    },
  });

  useWebMCPTool("list-todos", {
    description: "List all todo items with their ids and completion status.",
    title: "List todos",
    readOnly: true,
    run() {
      return {
        todos: todosRef.current,
        open: todosRef.current.filter((t) => !t.done).length,
      };
    },
  });

  // --- UI -----------------------------------------------------------------

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    addTodo(text);
    setDraft("");
  }

  return (
    <main className="app">
      <header>
        <h1>Todos</h1>
        <p className="subtitle">
          A webmcp-kit demo — every action below is also a WebMCP tool an AI
          agent can call. Host:{" "}
          <code>
            {hasNativeWebMCP() ? "native document.modelContext" : "ponyfill"}
          </code>
        </p>
      </header>

      <section className="card">
        <form onSubmit={onSubmit} className="add-row">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What needs doing?"
            aria-label="New todo"
          />
          <button type="submit">Add</button>
        </form>

        <ul className="todo-list">
          {todos.length === 0 && <li className="empty">Nothing to do.</li>}
          {todos.map((todo) => (
            <li key={todo.id} className={todo.done ? "done" : ""}>
              <span className="todo-id">#{todo.id}</span>
              <span className="todo-text">{todo.text}</span>
              <span className="todo-actions">
                {!todo.done && (
                  <button onClick={() => completeTodo(todo.id)}>Done</button>
                )}
                <button className="danger" onClick={() => deleteTodo(todo.id)}>
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <AgentToolsPanel />
      <SimulatePanel />
    </main>
  );
}

/** Live view of every tool currently registered through webmcp-kit. */
function AgentToolsPanel() {
  const tools = useRegisteredTools();
  return (
    <section className="card">
      <h2>Agent Tools</h2>
      <p className="hint">
        Registered on <code>document.modelContext</code> right now:
      </p>
      <ul className="tool-list">
        {tools.map((t) => (
          <li key={t.name}>
            <code className="tool-name">{t.name}</code>
            {t.descriptor.annotations?.readOnlyHint && (
              <span className="badge">read-only</span>
            )}
            <span className="tool-desc">{t.descriptor.description}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const SAMPLE_INPUTS: Record<string, string> = {
  "add-todo": '{ "text": "Buy milk" }',
  "complete-todo": '{ "id": 1 }',
  "delete-todo": '{ "id": 1 }',
  "list-todos": "{}",
};

/**
 * Invoke a tool exactly the way an agent would: through the host's
 * agent-side surface (the ponyfill's `executeTool`), falling back to the
 * kit registry handle when running on a native host (which doesn't expose
 * tool invocation to page script).
 */
async function invokeAsAgent(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const ctx = getModelContext("ponyfill");
  if (isPonyfill(ctx)) {
    return ctx.executeTool(name, input);
  }
  const handle = getRegisteredTool(name);
  if (!handle) throw new Error(`No tool named "${name}" is registered`);
  return handle.execute(input);
}

/** Dev panel: call any registered tool and watch the UI update. */
function SimulatePanel() {
  const tools = useRegisteredTools();
  const [selected, setSelected] = useState("add-todo");
  const [inputJson, setInputJson] = useState(SAMPLE_INPUTS["add-todo"] ?? "{}");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  function selectTool(name: string) {
    setSelected(name);
    setInputJson(SAMPLE_INPUTS[name] ?? "{}");
  }

  async function run() {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(inputJson) as Record<string, unknown>;
    } catch {
      setOutput("Input is not valid JSON.");
      return;
    }
    setBusy(true);
    try {
      const result = await invokeAsAgent(selected, input);
      setOutput(JSON.stringify(result, null, 2));
    } catch (err) {
      setOutput(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Simulate agent call</h2>
      <p className="hint">
        Calls go through <code>document.modelContext</code> — validation,
        confirm gates and all. Try invalid input (e.g.{" "}
        <code>{'{ "id": "nope" }'}</code>) to see boundary validation reject it,
        or <code>delete-todo</code> to hit the confirm gate.
      </p>
      <div className="sim-row">
        <select
          value={selected}
          onChange={(e) => selectTool(e.target.value)}
          aria-label="Tool"
        >
          {tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <button onClick={run} disabled={busy || tools.length === 0}>
          {busy ? "Running…" : "Invoke"}
        </button>
      </div>
      <textarea
        value={inputJson}
        onChange={(e) => setInputJson(e.target.value)}
        rows={3}
        aria-label="Tool input JSON"
        spellCheck={false}
      />
      {output && <pre className="output">{output}</pre>}
    </section>
  );
}
