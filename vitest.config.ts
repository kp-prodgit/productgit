import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "ee/test/**/*.test.ts"],
    testTimeout: 30000,
    // PMX_CLAUDE_HOME keeps tests out of the real ~/.claude (skills and scheduled tasks).
    env: { PMX_NO_NOTIFY: "1", PMX_CLAUDE_HOME: join(tmpdir(), `pmx-test-claude-${process.pid}`) },
  },
});
