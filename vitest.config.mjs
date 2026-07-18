import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.mjs"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
