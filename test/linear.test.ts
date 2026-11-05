import { describe, expect, it } from "vitest";
import { linearTracker } from "../src/tracker/linear.js";

/** A tiny fake of Linear's GraphQL API: just enough to exercise the adapter. */
function fakeLinear() {
  const labels: { id: string; name: string; isGroup: boolean; parent: { name: string } | null }[] = [];
  const issues = new Map<string, any>();
  const calls: string[] = [];
  let n = 0;
  const labelNodes = (ids: string[]) => ({ nodes: ids.map((id) => labels.find((l) => l.id === id)!).map((l) => ({ id: l.id, name: l.name, parent: l.parent })) });
  issues.set("other", { id: "other", identifier: "ENG-1", title: "x", description: "", url: "", priority: 0, createdAt: "", project: { id: "eng" }, labelIds: [], comments: [] });

  const f = (async (_url: string, init: any) => {
    const { query, variables: v } = JSON.parse(init.body);
    const op = query.match(/^\s*(query|mutation)[^{]*\{\s*(\w+)/)![2];
    calls.push(op);
    const view = (i: any) => ({ ...i, labels: labelNodes(i.labelIds), comments: { nodes: i.comments.map((body: string) => ({ body })) } });
    let data: any;
    switch (op) {
      case "teams": data = { teams: { nodes: [{ id: "team1" }] } }; break;
      case "team": data = { team: { labels: { nodes: labels } } }; break;
      case "issueLabelCreate": {
        const parent = v.i.parentId ? { name: labels.find((l) => l.id === v.i.parentId)!.name } : null;
        const l = { id: `L${++n}`, name: v.i.name, isGroup: !!v.i.isGroup, parent };
        labels.push(l);
        data = { issueLabelCreate: { issueLabel: { id: l.id, name: l.name } } };
        break;
      }
      case "issueCreate": {
        const id = `I${++n}`;
        issues.set(id, { id, identifier: `PMX-${n}`, title: v.i.title, description: v.i.description, url: `https://linear.app/x/${id}`, priority: 0, createdAt: "2026-11-03", project: { id: v.i.projectId }, labelIds: v.i.labelIds, comments: [] });
        data = { issueCreate: { issue: view(issues.get(id)) } };
        break;
      }
      case "issue": data = { issue: issues.has(v.id) ? view(issues.get(v.id)) : null }; break;
      case "issueUpdate": issues.get(v.id).labelIds = v.i.labelIds; data = { issueUpdate: { success: true } }; break;
      case "commentCreate": issues.get(v.i.issueId).comments.push(v.i.body); data = { commentCreate: { success: true } }; break;
      case "project": data = { project: { issues: { nodes: [...issues.values()].filter((i) => i.project.id === v.id).map(view), pageInfo: { hasNextPage: false, endCursor: null } } } }; break;
      default: throw new Error(`unexpected ${op}`);
    }
    return new Response(JSON.stringify({ data }));
  }) as any;
  return { f, labels, issues, calls };
}

describe("Linear adapter (SCOPE-1, TASK-6, SEC-4)", () => {
  it("creates inbox tasks with label groups and maps them back", async () => {
    const fake = fakeLinear();
    const t = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const created = await t.createInbox({ title: "Draft SCIM one-pager", description: "Why\n\npmx:source T1\npmx:source S2 https://slack.com/x", category: "spec", size: "M", sources: ["T1", "S2"] });
    expect(created).toMatchObject({ status: "inbox", category: "spec", size: "M", sources: ["T1", "S2"] });
    expect(fake.labels.filter((l) => l.isGroup).map((l) => l.name).sort()).toEqual(["pmx-category", "pmx-size", "pmx-status"]);

    await t.setStatus(created.id, "ready");
    await t.setAgent(created.id, "ana@m1");
    await t.comment(created.id, "pmx:pr https://github.com/acme/pmx/pull/7\nDrafted.");
    const got = await t.get(created.id);
    expect(got).toMatchObject({ status: "ready", agent: "ana@m1", prUrl: "https://github.com/acme/pmx/pull/7" });
    // One status label at a time.
    expect(fake.issues.get(created.id).labelIds.filter((id: string) => fake.labels.find((l) => l.id === id)!.parent?.name === "pmx-status")).toHaveLength(1);
    expect((await t.list({ status: ["ready"] })).map((x) => x.id)).toEqual([created.id]);
  });

  it("refuses to write to an issue outside the PMX project", async () => {
    const fake = fakeLinear();
    const t = linearTracker({ token: "oauth-token", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    await expect(t.setStatus("other", "done")).rejects.toThrow(/not in the PMX project \(SEC-4\)/);
    await expect(t.comment("other", "hi")).rejects.toThrow(/SEC-4/);
    expect(fake.calls).not.toContain("issueUpdate");
    expect(fake.calls).not.toContain("commentCreate");
  });
});
