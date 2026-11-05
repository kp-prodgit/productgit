---
name: pmx-size
description: The written size rubric for PMX tasks (S, M, L, XL) per category. Read by `pmx synthesize` when it sizes tasks; a human can override any size.
pmx: {"kind": "core", "sourceRanges": {"research-synthesis": {"S": [1, 2], "M": [3, 8], "L": [9, 20], "XL": [21, null]}}}
---

# Size rubric

Size is the expected agent effort to produce a reviewable draft, not the engineering effort.

| Size | Expected run | General rule |
|---|---|---|
| S | ~15 min | One source or one small artifact. Reviewable in 5 minutes. |
| M | ~30 min | A handful of sources, one document. Reviewable in 15 minutes. |
| L | ~60 min | Many sources or several sections with analysis. Reviewable in 30 minutes. |
| XL | ~120 min | Broad research across many sources. Split it if you can. |

## Per category

| Category | S | M | L | XL |
|---|---|---|---|---|
| research-synthesis | Summarize 1–2 calls | Themes across 3–8 sources | Themes across 9–20 sources with segments | A full research readout |
| competitive-analysis | One competitor, one feature | One competitor, full feature area | 3–5 competitors on one area | Market landscape |
| tracking-hygiene | Fix one epic's labels | Stale/duplicate report for one project | Whole PMX project audit | Cross-project audit |
| spec | Problem statement only | One-pager | Full PRD draft | PRD plus rollout and metrics plan |

When unsure between two sizes, pick the larger one.

## Explain every size

For each task, quote the cell from the per-category table that you matched, word for word, and say in
one sentence why the task fits it, for example "Five calls on one theme". Product Git checks the cell
against this table and, for research synthesis, the number of cited sources against the ranges above.
A disagreement is shown to the PM at triage; it doesn't block the task.
