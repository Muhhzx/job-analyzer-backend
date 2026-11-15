import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Cada execução usa um banco novo numa pasta temporária: os testes nunca tocam data/job-analyzer.db.
// A chave da IA fica vazia de propósito: nenhum teste pode gastar a cota da Anthropic.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    env: {
      DATABASE_PATH: path.join(os.tmpdir(), `job-analyzer-test-${process.pid}-${Date.now()}.db`),
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      NODE_ENV: "test",
    },
  },
});
