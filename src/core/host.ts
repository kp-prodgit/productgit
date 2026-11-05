import type { Fetch } from "../sources/slack.js";
import type { Exec } from "./exec.js";
import type { Git } from "./git.js";
import type { Keychain } from "./keychain.js";

/**
 * Where outputs land as pull requests (OUT-2). GitHub when the PMX repo has a GitHub remote,
 * otherwise local branches (single-player, no remote).
 */
export interface OutputHost {
  readonly kind: "github" | "local";
  openPr(o: { branch: string; base: string; title: string; body: string; labels?: string[] }): Promise<{ id: string; url: string }>;
  accept(id: string): Promise<void>;
  reject(id: string, comment: string): Promise<void>;
  comment(id: string, body: string): Promise<void>;
  /** Changed files with their content at the PR head, for the review queue. */
  files(id: string): Promise<{ path: string; content: string }[]>;
  isOpen(id: string): Promise<boolean>;
}

export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export async function githubToken(keychain: Keychain, exec: Exec): Promise<string | null> {
  const k = await keychain.get("github-token");
  if (k) return k;
  const r = await exec("gh", ["auth", "token"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export function githubHost(o: { owner: string; repo: string; token: string; fetch: Fetch; git: Git }): OutputHost {
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await o.fetch(`https://api.github.com/repos/${o.owner}/${o.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${o.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  return {
    kind: "github",
    async openPr(p) {
      await o.git.ok(["push", "-u", "origin", p.branch]);
      const pr: any = await api("POST", "/pulls", { title: p.title, head: p.branch, base: p.base, body: p.body });
      if (p.labels?.length) await api("POST", `/issues/${pr.number}/labels`, { labels: p.labels }).catch(() => {});
      return { id: String(pr.number), url: pr.html_url };
    },
    async accept(id) {
      await api("PUT", `/pulls/${id}/merge`, { merge_method: "squash" });
    },
    async reject(id, comment) {
      await api("POST", `/issues/${id}/comments`, { body: comment });
      await api("PATCH", `/pulls/${id}`, { state: "closed" });
    },
    async comment(id, body) {
      await api("POST", `/issues/${id}/comments`, { body });
    },
    async files(id) {
      const pr: any = await api("GET", `/pulls/${id}`);
      const files: any[] = (await api("GET", `/pulls/${id}/files?per_page=100`)) as any[];
      const out: { path: string; content: string }[] = [];
      for (const f of files.filter((x) => x.status !== "removed").slice(0, 30)) {
        const c: any = await api("GET", `/contents/${encodeURI(f.filename)}?ref=${pr.head.sha}`);
        out.push({ path: f.filename, content: Buffer.from(c.content ?? "", "base64").toString("utf8") });
      }
      return out;
    },
    async isOpen(id) {
      const pr: any = await api("GET", `/pulls/${id}`);
      return pr.state === "open";
    },
  };
}

/** Local branches stand in for PRs. Accept merges into the default branch of the PM's checkout. */
export function localHost(git: Git): OutputHost {
  return {
    kind: "local",
    async openPr(p) {
      return { id: p.branch, url: `branch:${p.branch}` };
    },
    async accept(branch) {
      const base = await git.defaultBranch();
      const current = (await git.ok(["branch", "--show-current"])).trim();
      if (current !== base || !(await git.isClean()))
        throw new Error(`To accept locally, check out ${base} with no uncommitted changes in ${git.cwd}.`);
      await git.ok(["merge", "--squash", branch]);
      await git.ok(["commit", "-q", "-m", `Accept ${branch}`]);
      await git.raw(["branch", "-D", branch]);
    },
    async reject(branch) {
      await git.raw(["branch", "-D", branch]);
    },
    async comment() {},
    async files(branch) {
      const base = await git.defaultBranch();
      const names = (await git.ok(["diff", "--name-only", "--diff-filter=d", `${base}...${branch}`])).split("\n").filter(Boolean);
      const out: { path: string; content: string }[] = [];
      for (const n of names) out.push({ path: n, content: await git.ok(["show", `${branch}:${n}`]) });
      return out;
    },
    async isOpen(branch) {
      return (await git.raw(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    },
  };
}

export async function outputHost(git: Git, keychain: Keychain, exec: Exec, f: Fetch): Promise<OutputHost> {
  const url = await git.remoteUrl();
  const gh = url ? parseGitHubRemote(url) : null;
  if (gh) {
    const token = await githubToken(keychain, exec);
    if (!token) throw new Error("The PMX repo is on GitHub but no GitHub token was found. Run `pmx init` or `gh auth login`.");
    return githubHost({ ...gh, token, fetch: f, git });
  }
  return localHost(git);
}
