import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The `@/` alias the tests were written against, carried over with them. tsconfig
 * declares it for the typechecker; vitest resolves modules itself and needs to
 * be told separately, which is why this file exists at all.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  // The tests under tests/scripts run the real shell scripts in a temp
  // consumer, and every config read starts bun. They take one to three
  // seconds alone and passed the 5s default only until the files ran
  // side by side with one that launches real sessions.
  test: { testTimeout: 30_000 },
});
