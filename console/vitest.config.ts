// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

/**
 * Tests run against a real, already-migrated Postgres (not a mock), same
 * as kernel/'s own suite:
 *
 *   createdb execution_console_test
 *   DATABASE_URL=postgresql://localhost/execution_console_test \
 *     JWT_SECRET=test-only-jwt-secret-of-32-bytes-or-more \
 *     KERNEL_API_URL=http://unused npm run db:migrate
 *
 * config.ts reads these at import time, so they have to be set here rather
 * than inside a test.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/globalSetup.ts"],
    env: {
      DATABASE_URL: process.env["TEST_DATABASE_URL"] ?? "postgresql://localhost/execution_console_test",
      JWT_SECRET: "test-only-jwt-secret-of-32-bytes-or-more",
      KEYLESS_AUDIENCE: "https://console.test",
      KERNEL_API_URL: "http://kernel-api.invalid",
      // The guides as they ship in the image (src/routes/docs.ts).
      DOCS_DIR: "docs",
      // No cluster: a Kubernetes call a test didn't mock fails, rather than
      // reaching whatever cluster this machine's kubeconfig points at.
      KUBECONFIG: "/nonexistent/vennir-tests-have-no-cluster",
      // Most tests stub the registry; the ones about pinning turn it on.
      IMAGE_PINNING: "off",
    },
  },
});
