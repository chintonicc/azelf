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
});
