import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,mjs}"],
    environment: "node",
    setupFiles: [],
    maxWorkers: "50%",
    forceRerunTriggers: ["schema/**", "src/**", "node/**", "scripts/**"],
  },
});
