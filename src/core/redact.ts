/**
 * Deterministic PII redaction (SEC-8). Runs before any text reaches a model.
 * Same input and same name list always give the same output, so runs stay neutral (NEUT-1).
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
// Standalone only: not part of a longer run of digit groups (an order or account number).
const PHONE = /(?<!\d[\s.-]?)(?:(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3,4}(?:[\s.-]\d{3,4})?|\+\d{9,15})(?![\s.-]?\d)/g;
const DATE_LIKE = /^\d{4}[-.]\d{2}[-.]\d{2}$|^\d{1,2}[-.]\d{1,2}[-.]\d{2,4}$/;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type RedactionKind = "email" | "phone" | "card" | "id" | "person";

export interface Redactor {
  redact(text: string): string;
  /** How many values of each kind were masked so far. Counts only, never the values. */
  readonly counts: Record<RedactionKind, number>;
}

/** `names` comes from the team's CRM allowlist file: one full name per line. */
export function makeRedactor(names: string[] = []): Redactor {
  const list = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))];
  // Longest first, so "Ana María López" wins over "Ana María".
  const ordered = list.map((n, i) => ({ n, tag: `[PERSON-${i + 1}]` })).sort((a, b) => b.n.length - a.n.length);
  const nameRes = ordered.map(({ n, tag }) => ({ re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "giu"), tag }));

  const counts: Record<RedactionKind, number> = { email: 0, phone: 0, card: 0, id: 0, person: 0 };
  const mask = (kind: RedactionKind, tag: string) => (counts[kind]++, tag);
  return {
    counts,
    redact(text) {
      let t = text.replace(EMAIL, () => mask("email", "[EMAIL]")).replace(SSN, () => mask("id", "[ID]"));
      t = t.replace(CARD, (m) => {
        const d = m.replace(/\D/g, "");
        return d.length >= 13 && d.length <= 19 && luhn(d) ? mask("card", "[CARD]") : m;
      });
      t = t.replace(PHONE, (m) => {
        const d = m.replace(/\D/g, "");
        if (DATE_LIKE.test(m.trim())) return m;
        return d.length >= 9 && d.length <= 15 ? mask("phone", "[PHONE]") : m;
      });
      for (const { re, tag } of nameRes) t = t.replace(re, () => mask("person", tag));
      return t;
    },
  };
}
