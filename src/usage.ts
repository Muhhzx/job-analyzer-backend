import { config } from "./config.js";
import { db } from "./db.js";

/**
 * Controle de gasto com IA. Os limites valem para o sistema inteiro (é a
 * mesma chave da API pagando tudo) e reiniciam todo dia 1º.
 */

// US$ por milhão de tokens (entrada, saída). Modelo desconhecido usa um preço
// alto para nunca subestimar o gasto.
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};
const FALLBACK_PRICE: [number, number] = [10, 50];

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const [inp, out] = PRICES[model] ?? FALLBACK_PRICE;
  // Haiku 5.5 cobra 5x acima de 100K tokens de entrada.
  const mult = model === "claude-haiku-5-5" && inputTokens > 100_000 ? 5 : 1;
  return ((inputTokens * inp + outputTokens * out) * mult) / 1_000_000;
}

export function recordUsage(userId: number, jobId: number | null, model: string, inputTokens: number, outputTokens: number) {
  db.prepare(
    "INSERT INTO ai_usage (user_id, job_id, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(userId, jobId, model, inputTokens, outputTokens, costUsd(model, inputTokens, outputTokens));
}

export function monthUsage() {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost FROM ai_usage
       WHERE created_at >= strftime('%Y-%m-01 00:00:00', 'now')`,
    )
    .get() as { n: number; cost: number };
  return {
    analyses: Number(row.n),
    costUsd: Number(row.cost),
    maxAnalyses: config.ai.maxAnalysesPerMonth,
    budgetUsd: config.ai.budgetUsdPerMonth,
  };
}

/** Motivo do bloqueio, ou null se ainda dá para usar a IA este mês. */
export function limitReached(): string | null {
  const u = monthUsage();
  if (u.analyses >= u.maxAnalyses) return `limite de ${u.maxAnalyses} análises no mês atingido`;
  if (u.costUsd >= u.budgetUsd) return `orçamento de US$ ${u.budgetUsd.toFixed(2)} no mês atingido`;
  return null;
}
