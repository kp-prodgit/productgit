import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts", "ee/test/**/*.test.ts"], testTimeout: 30000, env: { PMX_NO_NOTIFY: "1" } },
});
