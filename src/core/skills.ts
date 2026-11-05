import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the installed package: <root>/src/core or <root>/dist/src/core. */
export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.includes(join("dist", "src")) ? join(here, "..", "..", "..") : join(here, "..", "..");
}

/** Skills bundled with the CLI. Teams copy them into their PMX repo at init (NEUT-2). */
export function bundledSkillsDir(): string {
  return process.env.PMX_SKILLS_DIR ?? join(packageRoot(), "skills");
}

/** Team skills live in the PMX repo at `.claude/skills/<name>/SKILL.md`, changed only by PR. */
export function teamSkillPath(repoPath: string, skill: string): string {
  return join(repoPath, ".claude", "skills", skill, "SKILL.md");
}

export async function loadSkill(repoPath: string, skill: string): Promise<{ text: string; version: string; source: "team" | "bundled" }> {
  for (const [path, source] of [
    [teamSkillPath(repoPath, skill), "team"],
    [join(bundledSkillsDir(), skill, "SKILL.md"), "bundled"],
  ] as const) {
    try {
      const text = await readFile(path, "utf8");
      return { text, version: createHash("sha256").update(text).digest("hex").slice(0, 12), source };
    } catch {}
  }
  throw new Error(`Skill ${skill} not found in ${join(repoPath, ".claude", "skills")} or the bundled skills.`);
}

export async function listBundledSkills(): Promise<string[]> {
  return (await readdir(bundledSkillsDir(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/** Strips YAML frontmatter, leaving the instructions. */
export function skillBody(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

/** Which command runs which skill. Commands import their skill names from here, so this can't drift. */
export const SKILL_USES = {
  digest: ["pmx-digest"],
  synthesize: ["pmx-synthesize", "pmx-size"],
  brain: ["pmx-brain", "pmx-size"],
} as const;

const USED_BY: Record<string, string> = {
  "pmx-digest": "`pmx digest`: writes your weekly digest from your calls",
  "pmx-synthesize": "`pmx synthesize`: turns team signals into suggested tasks",
  "pmx-size": "`pmx synthesize`: the rubric it sizes each task with (S, M, L, XL)",
  "pmx-todo": "`pmx todo --refresh`: finds your own to-dos in your meetings; they stay on your Mac",
  "pmx-rollup": "`pmx company`: merges teams' tasks into company-level themes",
  "pmx-brain": "`pmx brain` (Team plan): assesses the board and proposes next actions; fixed rules decide what happens",
  "pmx-pull": "Not used by PMX runs. Helps you steer the queue from your own Claude Code session if you install the plugin",
};

export interface SkillInfo {
  name: string;
  description: string;
  kind: "core" | "category";
  category: string | null;
  usedBy: string;
  /** "team" copies in the PMX repo win over the copy bundled with the CLI. */
  runs: "team" | "bundled";
  version: string;
  /** "differs from built-in" means the team edited it, or this pmx has a newer built-in copy. */
  status: "same as built-in" | "differs from built-in" | "team only" | "built-in only";
  path: string;
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 12);

/** Every skill a PMX run can load, with what it does and when it runs (`pmx skills`, `pmx explain`). */
export async function skillInventory(repoPath: string, categories: Record<string, { skill: string }>): Promise<SkillInfo[]> {
  const teamDir = join(repoPath, ".claude", "skills");
  const teamNames = await readdir(teamDir, { withFileTypes: true }).then((es) => es.filter((e) => e.isDirectory()).map((e) => e.name), () => [] as string[]);
  const names = [...new Set([...(await listBundledSkills()), ...teamNames])].sort();
  const read = (p: string) => readFile(p, "utf8").catch(() => null);
  const out: SkillInfo[] = [];
  for (const name of names) {
    const team = await read(teamSkillPath(repoPath, name));
    const bundled = await read(join(bundledSkillsDir(), name, "SKILL.md"));
    const text = (team ?? bundled)!;
    const meta = frontmatter(text);
    const category = Object.entries(categories).find(([, c]) => c.skill === name)?.[0] ?? null;
    const pmx = meta.pmx ? (JSON.parse(meta.pmx) as { kind?: "core" | "category"; category?: string }) : {};
    out.push({
      name,
      description: meta.description ?? "",
      kind: pmx.kind ?? "core",
      category: category ?? pmx.category ?? null,
      usedBy: USED_BY[name] ?? (category ? `\`pmx pull\`: drafts ${category} tasks` : "Not used by this team's config"),
      runs: team ? "team" : "bundled",
      version: hash(text),
      status: !team ? "built-in only" : !bundled ? "team only" : hash(team) === hash(bundled) ? "same as built-in" : "differs from built-in",
      path: team ? teamSkillPath(repoPath, name) : join(bundledSkillsDir(), name, "SKILL.md"),
    });
  }
  return out;
}

function frontmatter(text: string): Record<string, string> {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  return Object.fromEntries(fm.split("\n").map((l) => l.match(/^(\w+):\s*(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1]!, m[2]!]));
}
