import { createInterface } from "node:readline/promises";

/** Interactive prompts. With `--yes` or no TTY, every question takes its default. */
export interface Asker {
  text(q: string, def?: string): Promise<string>;
  secret(q: string): Promise<string>;
  confirm(q: string, def?: boolean): Promise<boolean>;
  choose<T extends string>(q: string, options: T[], def: T): Promise<T>;
}

export function ttyAsker(nonInteractive = !process.stdin.isTTY): Asker {
  const ask = async (q: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(q)).trim();
    } finally {
      rl.close();
    }
  };
  return {
    async text(q, def = "") {
      if (nonInteractive) return def;
      const a = await ask(`${q}${def ? ` [${def}]` : ""}: `);
      return a || def;
    },
    async secret(q) {
      if (nonInteractive) return "";
      // Read without echo, so tokens never show on screen or in scrollback.
      process.stdout.write(`${q}: `);
      const stdin = process.stdin;
      stdin.setRawMode?.(true);
      stdin.resume();
      return new Promise((resolve) => {
        let buf = "";
        const onData = (d: Buffer) => {
          for (const ch of d.toString("utf8")) {
            if (ch === "\r" || ch === "\n") {
              stdin.off("data", onData);
              stdin.setRawMode?.(false);
              stdin.pause();
              process.stdout.write("\n");
              return resolve(buf.trim());
            }
            if (ch === "\u0003") process.exit(130);
            if (ch === "\u007f") buf = buf.slice(0, -1);
            else buf += ch;
          }
        };
        stdin.on("data", onData);
      });
    },
    async confirm(q, def = true) {
      if (nonInteractive) return def;
      const a = (await ask(`${q} ${def ? "[Y/n]" : "[y/N]"}: `)).toLowerCase();
      return a ? a.startsWith("y") : def;
    },
    async choose(q, options, def) {
      if (nonInteractive) return def;
      // A typo re-asks instead of silently taking the default.
      for (;;) {
        const a = await ask(`${q} (${options.join("/")}) [${def}]: `);
        if (!a) return def;
        const hit = options.find((o) => o === a.toLowerCase());
        if (hit) return hit;
        console.warn(`Pick one of ${options.join(", ")}.`);
      }
    },
  };
}

/** Scripted answers for tests. Unanswered questions take their default. */
export function scriptedAsker(answers: Record<string, string | boolean>): Asker {
  const find = (q: string) => Object.entries(answers).find(([k]) => q.toLowerCase().includes(k.toLowerCase()))?.[1];
  return {
    async text(q, def = "") { const a = find(q); return typeof a === "string" ? a : def; },
    async secret(q) { const a = find(q); return typeof a === "string" ? a : ""; },
    async confirm(q, def = true) { const a = find(q); return typeof a === "boolean" ? a : def; },
    async choose(q, options, def) { const a = find(q); return (options.find((o) => o === a) ?? def) as any; },
  };
}
