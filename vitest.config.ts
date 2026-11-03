import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Nothing here is allowed to reach the network. Tests use the fake provider,
    // the memory store and an injected Claude client.
    testTimeout: 20000,
  },
});
