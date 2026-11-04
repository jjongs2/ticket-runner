import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "wiki/.vitepress/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
