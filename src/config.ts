import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // Sem .env: usa só as variáveis de ambiente e os padrões abaixo.
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 4000),
  dbPath: path.resolve(ROOT, process.env.DATABASE_PATH ?? "data/job-analyzer.db"),
  production: process.env.NODE_ENV === "production",
  /**
   * Vagas com nota abaixo disso ficam salvas, mas não aparecem em lugar nenhum.
   * Salvas para que a próxima busca não traga a mesma vaga de novo.
   */
  minVisibleScore: num(process.env.MIN_VISIBLE_SCORE, 20),
  ai: {
    enabled: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
    maxAnalysesPerMonth: num(process.env.AI_MONTHLY_MAX_ANALYSES, 500),
    budgetUsdPerMonth: num(process.env.AI_MONTHLY_BUDGET_USD, 2),
    prefilterMinScore: num(process.env.AI_PREFILTER_MIN_SCORE, 30),
  },
};
