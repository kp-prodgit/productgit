import type { Size, Status, Task } from "../core/types.js";

export interface NewTask {
  title: string;
  description: string;
  category: string;
  size: Size;
  sources: string[];
}

/** A team meeting lodged in the tracker's meeting ledger (MEET-2). Not a task: pull, the brain and the board skip it. */
export interface MeetingEntry {
  id: string;
  identifier: string;
  url: string;
  title: string;
  /** The meeting identity hashes (`pmx:meeting` lines). */
  keys: string[];
  status: "running" | "done" | "blocked";
  /** Tasks the meeting produced (`pmx:task` lines). */
  tasks: string[];
  agent: string | null;
}

export interface NewMeeting {
  title: string;
  keys: string[];
  at: string;
  source: string;
  agent: string;
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
  /** The meeting ledger (MEET-2). `list()` never returns these. */
  listMeetings(): Promise<MeetingEntry[]>;
  lodgeMeeting(m: NewMeeting): Promise<MeetingEntry>;
  /** Marks a lodged meeting done (completed in the tracker) or blocked, with the tasks it produced. */
  finishMeeting(id: string, o: { status: "done" | "blocked"; tasks: string[]; note: string }): Promise<void>;
}

export const meetingDescription = (m: NewMeeting) =>
  [`Lodged by PMX so no one processes this meeting twice (MEET-2). Not a task.`, ``, `Date: ${m.at}`, `Source: ${m.source}`, `Processed by: ${m.agent}`, ``, ...m.keys.map((k) => `pmx:meeting ${k}`)].join("\n");

/** An in-memory tracker for tests, demos and teams that haven't connected Linear yet. */
export function memoryTracker(seed: Task[] = []): Tracker & { tasks: Map<string, Task>; comments: Map<string, string[]>; meetings: Map<string, MeetingEntry> } {
  const tasks = new Map(seed.map((t) => [t.id, { ...t }]));
  const meetings = new Map<string, MeetingEntry>();
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
    meetings,
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
    async listMeetings() {
      return [...meetings.values()].map((m) => ({ ...m, keys: [...m.keys], tasks: [...m.tasks] }));
    },
    async lodgeMeeting(m) {
      const id = `meeting-${++n}`;
      const e: MeetingEntry = { id, identifier: `PMX-${n}`, url: `memory://${id}`, title: m.title, keys: [...m.keys], status: "running", tasks: [], agent: m.agent };
      meetings.set(id, e);
      return { ...e };
    },
    async finishMeeting(id, o) {
      const e = meetings.get(id);
      if (!e) throw new Error(`No meeting ${id} in the PMX project.`);
      e.status = o.status;
      e.tasks = [...new Set([...e.tasks, ...o.tasks])];
      comments.set(id, [...(comments.get(id) ?? []), o.note]);
    },
  };
}
