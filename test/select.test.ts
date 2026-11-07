import { describe, expect, it } from "vitest";
import { budget } from "../src/budget/provider.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import type { Task } from "../src/core/types.js";
import { explain, selectTasks, type SelectInput } from "../src/pull/select.js";
import { personal } from "./helpers.js";

const team = { ...DEFAULT_TEAM, team: "t" } as TeamConfig;
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, identifier: id, title: `Task ${id}`, description: "", url: "", category: "spec", size: "M", status: "ready",
  priority: 3, agent: null, sources: [], prUrl: null, createdAt: `2026-11-0${id.slice(-1)}T00:00:00Z`, ...over,
});

function input(over: Partial<SelectInput> = {}): SelectInput {
  const p = personal("/r", { workingHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" } });
  const now = new Date(2026, 10, 4, 10, 0); // Wednesday 10:00 local
  return {
    tasks: [], agent: "ana@m1", personal: p, team, now,
    budget: budget(p, team, { ledger: {}, lastDigestWeek: null, lastSynthAt: null, eeTrialStartedAt: null, lastEventSyncAt: null }, now),
    inReview: 0, pausedCategories: new Map(), leasedTaskIds: new Set(), ...over,
  };
}

describe("pull policy and dry-run explanations (PULL-1..4, PULL-9)", () => {
  it("orders by priority then age, and explains every skip", () => {
    const s = selectTasks(input({
      tasks: [
        task("T1", { priority: 0 }),
        task("T2", { priority: 2 }),
        task("T3", { priority: 2, category: "roadmap" }),
        task("T4", { priority: 1, size: null }),
        task("T5", { priority: 1, status: "inbox" }),
        task("T6", { priority: 2, category: "competitive-analysis" }),
      ],
      leasedTaskIds: new Set(["T6"]),
    }));
    expect(s.candidates.map((t) => t.id)).toEqual(["T2", "T1"]);
    const why = Object.fromEntries(s.decisions.map((d) => [d.task.id, d.why]));
    expect(why.T3).toMatch(/no skill in team config/);
    expect(why.T4).toMatch(/no size label/);
    expect(why.T6).toMatch(/already claimed/);
    expect(why.T5).toBeUndefined();
    expect(explain(s, true)).toMatch(/Would pull: T2/);
  });

  it("works whenever the Mac is on, even with old saved hours; blocks at the review cap and with no budget", () => {
    const tasks = [task("T1")];
    // A Saturday night, outside the 0.12.0-era hours saved in this config: no longer a blocker (0.13.0).
    expect(selectTasks(input({ tasks, now: new Date(2026, 10, 7, 23, 30) })).blockers).toEqual([]);
    expect(selectTasks(input({ tasks, inReview: 3 })).blockers[0]).toMatch(/3 of your drafts are waiting for review \(cap 3\)/);
    const spent = input({ tasks });
    spent.budget = { ...spent.budget, remainingUsd: 0, spentUsd: 10 };
    expect(selectTasks(spent).blockers[0]).toMatch(/no budget left/);
    expect(selectTasks(spent).candidates).toEqual([]);
  });

  it("won't start L or XL close to the budget reset, or tasks that cost more than what's left", () => {
    const i = input({ tasks: [task("T1", { size: "XL" }), task("T2", { size: "L" }), task("T3", { size: "S" })] });
    i.budget = { ...i.budget, minutesToReset: 45, remainingUsd: 5 };
    const s = selectTasks(i);
    expect(s.decisions.find((d) => d.task.id === "T1")!.why).toMatch(/needs ~\$8\.00, \$5\.00 left/);
    expect(s.decisions.find((d) => d.task.id === "T2")!.why).toMatch(/only 45 min until the budget resets/);
    expect(s.candidates.map((t) => t.id)).toEqual(["T3"]);
  });

  it("respects accepted categories and paused categories", () => {
    const p = personal("/r", { categories: ["spec"], workingHours: { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" } });
    const s = selectTasks(input({
      personal: p,
      tasks: [task("T1", { category: "research-synthesis" }), task("T2")],
      pausedCategories: new Map([["spec", "accept rate 20% over 10 reviews"]]),
    }));
    expect(s.decisions.map((d) => d.why)).toEqual([expect.stringMatching(/don't accept research-synthesis/), expect.stringMatching(/spec is paused: accept rate 20%/)]);
  });

  it("team per-machine cap beats a higher personal cap and the override", () => {
    const p = personal("/r", { budget: { dailyUsd: 100, resetHour: 0, overrideUsd: 500 } });
    const b = budget(p, team, { ledger: {}, lastDigestWeek: null, lastSynthAt: null, eeTrialStartedAt: null, lastEventSyncAt: null }, new Date());
    expect(b.remainingUsd).toBe(team.caps.perDayUsd);
  });
});
