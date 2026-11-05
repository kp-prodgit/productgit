import { SIZES, STATUSES, type Size, type Status, type Task } from "../core/types.js";
import type { Fetch } from "../sources/slack.js";
import { meetingDescription, type MeetingEntry, type NewTask, type Tracker } from "./types.js";

/**
 * Linear adapter (SCOPE-1). PMX fields are label groups, not custom fields, so no Linear admin
 * is needed (TASK-6). The mapping is shared with the control plane's canvas proxy
 * (docs/control-plane-api.md).
 */
export const GROUPS = { status: "pmx-status", category: "pmx-category", size: "pmx-size", agent: "pmx-agent", kind: "pmx-kind" } as const;
type Group = keyof typeof GROUPS;

interface Label {
  id: string;
  name: string;
  group: string | null;
}

export interface LinearOpts {
  /** A personal API key (`lin_api_…`) or a brokered OAuth access token (M5). */
  token: string;
  teamKey: string;
  projectId: string;
  fetch?: Fetch;
}

const ISSUE_FIELDS = `id identifier title description url priority createdAt
  project { id }
  labels { nodes { id name parent { name } } }`;

/** Linear issue nodes as both the API and the Claude relay snapshot carry them (one mapping, CANVAS-2). */
export const kindOf = (n: any) => n.labels.nodes.find((l: any) => l.parent?.name === GROUPS.kind)?.name ?? "task";

export function toTask(n: any): Task {
  const ls: { name: string; group: string | null }[] = n.labels.nodes.map((l: any) => ({ name: l.name, group: l.parent?.name ?? null }));
  const pick = (g: Group) => ls.find((l) => l.group === GROUPS[g])?.name ?? null;
  const status = pick("status");
  const size = pick("size");
  const desc: string = n.description ?? "";
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: desc,
    url: n.url,
    category: pick("category"),
    size: SIZES.includes(size as Size) ? (size as Size) : null,
    status: STATUSES.includes(status as Status) ? (status as Status) : null,
    priority: n.priority ?? 0,
    agent: pick("agent"),
    sources: [...desc.matchAll(/^pmx:source (\S+)/gm)].map((m) => m[1]!),
    prUrl: ((n.comments?.nodes ?? []) as any[]).map((c) => c.body?.match(/^pmx:pr (\S+)/m)?.[1]).filter(Boolean).at(-1) ?? null,
    createdAt: n.createdAt,
  };
}

export function toMeeting(n: any): MeetingEntry {
  const t = toTask(n);
  return {
    id: t.id, identifier: t.identifier, url: t.url, title: t.title,
    keys: [...t.description.matchAll(/^pmx:meeting (\S+)/gm)].map((m) => m[1]!),
    status: t.status === "done" ? "done" : t.status === "blocked" ? "blocked" : "running",
    tasks: [...t.description.matchAll(/^pmx:task (\S+)/gm)].map((m) => m[1]!),
    agent: t.agent,
  };
}

export function linearTracker(o: LinearOpts): Tracker {
  const f = o.fetch ?? fetch;
  const auth = o.token.startsWith("lin_api_") ? o.token : `Bearer ${o.token}`;
  let teamId: string | null = null;
  let labels: Label[] | null = null;

  async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await f("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body: any = await res.json();
    if (body.errors?.length) throw new Error(`Linear: ${body.errors.map((e: any) => e.message).join("; ")}`);
    if (!res.ok) throw new Error(`Linear: HTTP ${res.status}`);
    return body.data as T;
  }

  async function team(): Promise<string> {
    if (teamId) return teamId;
    const d = await gql(`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`, { key: o.teamKey });
    teamId = d.teams.nodes[0]?.id ?? null;
    if (!teamId) throw new Error(`Linear team ${o.teamKey} not found.`);
    return teamId;
  }

  async function allLabels(): Promise<Label[]> {
    if (labels) return labels;
    const id = await team();
    const d = await gql(`query($id: String!) { team(id: $id) { labels(first: 250) { nodes { id name isGroup parent { name } } } } }`, { id });
    labels = d.team.labels.nodes.map((l: any) => ({ id: l.id, name: l.name, group: l.parent?.name ?? (l.isGroup ? null : null) }));
    return labels!;
  }

  /** Finds or creates the label `name` inside group `g` (and the group itself). */
  async function label(g: Group, name: string): Promise<string> {
    const all = await allLabels();
    const groupName = GROUPS[g];
    const hit = all.find((l) => l.group === groupName && l.name === name);
    if (hit) return hit.id;
    const tid = await team();
    let parent = all.find((l) => l.group === null && l.name === groupName);
    if (!parent) {
      const d = await gql(`mutation($i: IssueLabelCreateInput!) { issueLabelCreate(input: $i) { issueLabel { id name } } }`, {
        i: { name: groupName, teamId: tid, isGroup: true },
      });
      parent = { id: d.issueLabelCreate.issueLabel.id, name: groupName, group: null };
      all.push(parent);
    }
    const d = await gql(`mutation($i: IssueLabelCreateInput!) { issueLabelCreate(input: $i) { issueLabel { id name } } }`, {
      i: { name, teamId: tid, parentId: parent.id },
    });
    const created = { id: d.issueLabelCreate.issueLabel.id, name, group: groupName };
    all.push(created);
    return created.id;
  }

  async function allIssues(): Promise<any[]> {
    const out: any[] = [];
    let after: string | null = null;
    do {
      const d: any = await gql(
        `query($id: String!, $after: String) { project(id: $id) { issues(first: 100, after: $after) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
        { id: o.projectId, after },
      );
      const page = d.project.issues;
      out.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  /** The team's first workflow state of type "completed", so a finished meeting shows as Done in Linear. */
  async function completedState(): Promise<string | null> {
    const d = await gql(`query($id: String!) { team(id: $id) { states { nodes { id type position } } } }`, { id: await team() });
    return (d.team.states.nodes as any[]).filter((x) => x.type === "completed").sort((a, b) => a.position - b.position)[0]?.id ?? null;
  }

  /** SEC-4: refuse any write to an issue outside the PMX project. */
  async function inProject(id: string): Promise<any> {
    const d = await gql(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} comments(last: 50) { nodes { body } } } }`, { id });
    if (!d.issue) throw new Error(`Linear issue ${id} not found.`);
    if (d.issue.project?.id !== o.projectId) throw new Error(`Refusing to write to ${d.issue.identifier}: it is not in the PMX project (SEC-4).`);
    return d.issue;
  }

  async function setGroupLabel(id: string, g: Group, value: string | null): Promise<void> {
    const issue = await inProject(id);
    const keep = issue.labels.nodes.filter((l: any) => l.parent?.name !== GROUPS[g]).map((l: any) => l.id);
    const labelIds = value ? [...keep, await label(g, value)] : keep;
    await gql(`mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }`, { id, i: { labelIds } });
  }

  return {
    kind: "linear",
    async list(opts) {
      // Meeting ledger entries are not tasks (MEET-2).
      const out = (await allIssues()).filter((n) => kindOf(n) !== "meeting").map(toTask);
      return opts?.status ? out.filter((t) => t.status !== null && opts.status!.includes(t.status)) : out;
    },
    async get(id) {
      return toTask(await inProject(id));
    },
    async createInbox(t: NewTask) {
      const labelIds = [await label("status", "inbox"), await label("category", t.category), await label("size", t.size)];
      const d = await gql(`mutation($i: IssueCreateInput!) { issueCreate(input: $i) { issue { ${ISSUE_FIELDS} } } }`, {
        i: { teamId: await team(), projectId: o.projectId, title: t.title, description: t.description, labelIds },
      });
      return toTask(d.issueCreate.issue);
    },
    async setStatus(id, status) {
      await setGroupLabel(id, "status", status);
    },
    async setAgent(id, agent) {
      await setGroupLabel(id, "agent", agent);
    },
    async setSize(id, size) {
      await setGroupLabel(id, "size", size);
    },
    async setPriority(id, priority) {
      await inProject(id);
      await gql(`mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }`, { id, i: { priority } });
    },
    async addNote(id, note) {
      const issue = await inProject(id);
      const description = `${issue.description ?? ""}\npmx:note ${note.replace(/\s+/g, " ").trim()}`;
      await gql(`mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }`, { id, i: { description } });
    },
    async listMeetings() {
      return (await allIssues()).filter((n) => kindOf(n) === "meeting").map(toMeeting);
    },
    async lodgeMeeting(m) {
      const labelIds = [await label("kind", "meeting"), await label("status", "running"), await label("agent", m.agent)];
      const d = await gql(`mutation($i: IssueCreateInput!) { issueCreate(input: $i) { issue { ${ISSUE_FIELDS} } } }`, {
        i: { teamId: await team(), projectId: o.projectId, title: `Meeting · ${m.title} · ${m.at}`, description: meetingDescription(m), labelIds },
      });
      return toMeeting(d.issueCreate.issue);
    },
    async finishMeeting(id, f) {
      const issue = await inProject(id);
      if (kindOf(issue) !== "meeting") throw new Error(`Refusing to finish ${issue.identifier}: it is a task, not a lodged meeting.`);
      const lines = f.tasks.filter((t) => !(issue.description ?? "").includes(`pmx:task ${t}`)).map((t) => `pmx:task ${t}`);
      const description = lines.length ? `${issue.description ?? ""}\n${lines.join("\n")}` : issue.description;
      const stateId = f.status === "done" ? await completedState() : null;
      await gql(`mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }`, { id, i: { description, ...(stateId ? { stateId } : {}) } });
      await setGroupLabel(id, "status", f.status);
      await gql(`mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }`, { i: { issueId: id, body: f.note } });
    },
    async comment(id, body) {
      await inProject(id);
      await gql(`mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }`, { i: { issueId: id, body } });
    },
  };
}
