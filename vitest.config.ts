import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests run against synthetic fixtures and the local enw_test database, never firm data.
const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/enw_test";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/globalSetup.ts"],
    fileParallelism: false,
    env: {
      DEALCLOUD_SNAPSHOT_DIR: path.resolve(__dirname, "tests/fixtures/dealcloud"),
      DATABASE_URL: TEST_DB,
    },
  },
});
