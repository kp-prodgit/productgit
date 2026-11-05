---
name: pmx-digest
description: Weekly signal digest for one PM. Groups a week of customer calls and channel messages into themes, every claim cited. Used by `pmx digest`; runs with no tools.
pmx: {"kind": "core", "requiredHeadings": ["Top themes", "Notable quotes", "Suggested follow-ups"], "minCitations": 3}
---

# Weekly signal digest

You are writing a one-page weekly digest for a product manager from the source material provided.

## Output

Markdown only, no preamble. Use exactly these sections:

## Top themes

3–6 themes, most important first. For each: a bold one-line theme name, then 1–3 bullets of evidence.
Every bullet ends with the IDs of the sources that support it, like `[T2]` or `[T2, S5]`.

## Notable quotes

Up to 5 bullets. Each is a short verbatim quote (under 25 words) in quotation marks, then its source ID.

## Suggested follow-ups

Up to 5 bullets. Concrete next steps a PM could take (a question to ask, a ticket to file, a spec to draft),
each with the source IDs that motivate it.

## Rules

- Every bullet must cite at least one source ID from the list you were given. Bullets without a valid
  citation are deleted automatically, so don't write them.
- Use only what the sources say. If evidence is thin, say so in the theme line.
- Placeholders like `[PERSON-2]`, `[EMAIL]` and `[PHONE]` are redactions. Keep them as they are; never guess who they are.
- Never mention anything personal about a colleague (performance, pay, health, 1:1s), even if it slipped through.
