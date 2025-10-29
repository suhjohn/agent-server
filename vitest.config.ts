import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.{test,spec}.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    reporters: ["dot"],
  },
});


