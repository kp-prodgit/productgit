import type { Size, Status, Task } from "../core/types.js";

export interface NewTask {
  title: string;
  description: string;
  category: string;
  size: Size;
  sources: string[];
}

/**
 * The tracker as the engine sees it (one adapter per tracker, CANVAS-2).
 * Every write is limited to the PMX project, enforced inside the adapter (SEC-4).
 */
export interface Tracker {
  readonly kind: string;
  list(o?: { status?: Status[] }): Promise<Task[]>;
  get(id: string): Promise<Task>;
  /** Synthesis can only create tasks in `inbox` (SIG-4, SEC-1). */
  createInbox(t: NewTask): Promise<Task>;
  setStatus(id: string, status: Status): Promise<void>;
  setAgent(id: string, agent: string | null): Promise<void>;
  setSize(id: string, size: Size): Promise<void>;
  /** 1 urgent … 4 low, 0 none (Linear's scale). */
  setPriority(id: string, priority: number): Promise<void>;
  comment(id: string, body: string): Promise<void>;
  /** A reviewer's redo note, appended to the description as a `pmx:note` line (REV-2). */
  addNote(id: string, note: string): Promise<void>;
}

/** An in-memory tracker for tests, demos and teams that haven't connected Linear yet. */
export function memoryTracker(seed: Task[] = []): Tracker & { tasks: Map<string, Task>; comments: Map<string, string[]> } {
  const tasks = new Map(seed.map((t) => [t.id, { ...t }]));
  const comments = new Map<string, string[]>();
  let n = seed.length;
  const must = (id: string) => {
    const t = tasks.get(id);
    if (!t) throw new Error(`No task ${id} in the PMX project.`);
    return t;
  };
  return {
    kind: "memory",
    tasks,
    comments,
    async list(o) {
      return [...tasks.values()].filter((t) => !o?.status || (t.status !== null && o.status.includes(t.status))).map((t) => ({ ...t }));
    },
    async get(id) {
      const t = must(id);
      return { ...t, prUrl: [...(comments.get(id) ?? [])].reverse().map((c) => c.match(/^pmx:pr (\S+)/m)?.[1]).find(Boolean) ?? t.prUrl };
    },
    async createInbox(t) {
      const id = `task-${++n}`;
      const task: Task = {
        id, identifier: `PMX-${n}`, title: t.title, description: t.description, url: `memory://${id}`,
        category: t.category, size: t.size, status: "inbox", priority: 0, agent: null, sources: t.sources, prUrl: null,
        createdAt: new Date().toISOString(),
      };
      tasks.set(id, task);
      return { ...task };
    },
    async setStatus(id, status) { must(id).status = status; },
    async setAgent(id, agent) { must(id).agent = agent; },
    async setSize(id, size) { must(id).size = size; },
    async setPriority(id, priority) { must(id).priority = priority; },
    async comment(id, body) {
      must(id);
      comments.set(id, [...(comments.get(id) ?? []), body]);
    },
    async addNote(id, note) {
      const t = must(id);
      t.description = `${t.description}\npmx:note ${note.replace(/\s+/g, " ").trim()}`;
    },
  };
}
