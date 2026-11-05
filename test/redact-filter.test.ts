import { describe, expect, it } from "vitest";
import { filterItems, TOPICS } from "../src/core/filter.js";
import { makeRedactor } from "../src/core/redact.js";
import type { SignalItem } from "../src/core/types.js";

describe("redaction (SEC-8)", () => {
  const r = makeRedactor(["Jane Doe", "Ana María López"]);

  it("redacts emails, phones, cards, SSNs and listed names", () => {
    const t = r.redact("Jane Doe (jane@acme.com, +1 415-555-0134) paid with 4111 1111 1111 1111, SSN 123-45-6789. ana maría lópez agreed.");
    expect(t).toBe("[PERSON-1] ([EMAIL], [PHONE]) paid with [CARD], SSN [ID]. [PERSON-2] agreed.");
  });

  it("leaves dates, times, versions and non-Luhn numbers alone", () => {
    const t = r.redact("On 2026-11-03 at 10:30 we shipped v2.1.300; order 1234 5678 9012 3456 is fine.");
    expect(t).toBe("On 2026-11-03 at 10:30 we shipped v2.1.300; order 1234 5678 9012 3456 is fine.");
  });

  it("is deterministic", () => {
    const s = "Call Jane Doe at 415.555.0134";
    expect(r.redact(s)).toBe(makeRedactor(["Jane Doe", "Ana María López"]).redact(s));
  });

  it("doesn't redact a name inside a longer word", () => {
    expect(makeRedactor(["Ann"]).redact("Annual plan, Ann said")).toBe("Annual plan, [PERSON-1] said");
  });
});

const item = (over: Partial<SignalItem>): SignalItem => ({
  id: "T1", kind: "transcript", ref: "/x/call.md", title: "Acme call", at: "2026-11-02",
  participants: ["jane@acme.com", "kp@us.com"], text: "Jane: We need SCIM.", ...over,
});

describe("personal-content filter (B2, PRIV-2)", () => {
  const rules = { internalDomains: ["us.com"], requireExternalParticipant: true, neverIngest: { people: ["Bob Smith"], channels: ["#hr"], meetingTitles: ["Leadership offsite"] } };

  it("drops 1:1s, never-ingest meetings and calls without an external participant", () => {
    const r = filterItems(
      [
        item({ id: "T1" }),
        item({ id: "T2", title: "Ana / Raj 1:1" }),
        item({ id: "T3", title: "Leadership Offsite planning" }),
        item({ id: "T4", participants: ["a@us.com", "b@us.com"] }),
        item({ id: "T5", participants: [] }),
        item({ id: "T6", participants: ["jane@acme.com", "Bob Smith"] }),
      ],
      rules,
    );
    expect(r.kept.map((i) => i.id)).toEqual(["T1"]);
    expect(r.held).toMatchObject({ "one-on-one": 1, "never-ingest": 2, "no-external-participant": 1, "unknown-participants": 1 });
    expect(r.heldItems).toBe(5);
  });

  it("drops performance, pay and health passages but keeps the rest of the call", () => {
    const text = [
      "Jane: SSO setup takes two hours.",
      "",
      "Raj: Off topic, my performance review is next week.",
      "",
      "Raj: And I'm waiting on my bonus.",
      "",
      "Raj: I was on sick leave last week.",
      "",
      "Jane: SCIM would fix it.",
      "",
      "Jane: Bob Smith told me the same.",
    ].join("\n");
    const r = filterItems([item({ text })], rules);
    expect(r.kept[0]!.text).toContain("SSO setup takes two hours.");
    expect(r.kept[0]!.text).toContain("SCIM would fix it.");
    expect(r.kept[0]!.text).not.toMatch(/performance|bonus|sick|Bob/);
    expect(r.held).toMatchObject({ performance: 1, compensation: 1, health: 1, "never-ingest": 1 });
  });

  it("slack items skip the external-participant rule", () => {
    const r = filterItems([item({ kind: "slack", participants: ["U123"] })], rules);
    expect(r.kept).toHaveLength(1);
  });

  it("topic rules don't fire on ordinary product talk", () => {
    for (const s of ["Our pricing page converts poorly", "Review the onboarding flow", "The health check endpoint is slow"])
      for (const [k, re] of Object.entries(TOPICS)) if (k !== "health" || !s.includes("health check")) expect(re.test(s), `${k}: ${s}`).toBe(false);
  });
});
