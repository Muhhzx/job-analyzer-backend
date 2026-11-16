import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import { notify } from "./notify.js";
import { getProfile, profileToText, type Profile } from "./profile.js";
import { NOT_BLOCKED_SQL } from "./blockers.js";
import { acceptedLevels, seniorityFilterSql } from "./seniority.js";
import { limitReached, recordUsage } from "./usage.js";

/**
 * Análise com IA. Só roda quando o usuário pede (botão "Analisar com IA",
 * com confirmação) ou na análise automática, se ele ligou essa opção.
 * A nota grátis por palavras-chave fica em preview.ts.
 */

export type Job = {
  id: number;
  user_id: number;
  source: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  posted_at: string | null;
  status: string;
  created_at: string;
  preview_score: number | null;
  preview: string | null;
};

const AnalysisSchema = z.object({
  score: z.number().int().describe("Compatibilidade de 0 a 100 entre o candidato e a vaga"),
  verdict: z.enum(["excelente", "boa", "parcial", "fraca"]),
  summary: z.string().describe("2 a 3 frases explicando a nota"),
  strengths: z.array(z.string()).describe("Requisitos da vaga que o candidato atende"),
  gaps: z.array(z.string()).describe("Requisitos que faltam ou estão fracos"),
  red_flags: z.array(z.string()).describe("Conflitos com senioridade, deal breakers, local, modelo de trabalho, salário etc."),
  application_tips: z.string().describe("Como o candidato deve se posicionar ao se candidatar"),
  salary_estimate: z
    .object({
      source: z
        .enum(["informado na vaga", "estimativa"])
        .describe("'informado na vaga' só se a descrição traz o valor; senão 'estimativa'"),
      min: z.number().int().describe("Valor mínimo da faixa"),
      max: z.number().int().describe("Valor máximo da faixa"),
      currency: z.enum(["BRL", "USD", "EUR"]),
      period: z.enum(["mensal", "anual", "por hora"]),
      contract: z.enum(["CLT", "PJ", "não informado"]).describe("Regime a que a faixa se refere"),
      basis: z.string().describe("1 frase: de onde veio o valor (trecho da vaga ou o que embasou a estimativa)"),
      vs_candidate: z
        .enum(["acima da pretensão", "dentro da pretensão", "abaixo da pretensão", "pretensão não informada"])
        .describe("Comparação com a pretensão salarial mínima do candidato"),
    })
    .describe("Faixa salarial da vaga: a informada, ou uma estimativa de mercado"),
});

export type Analysis = z.infer<typeof AnalysisSchema> & { engine: string };

const SYSTEM_PROMPT = `Você é um recrutador técnico experiente que avalia a compatibilidade entre um candidato e uma vaga no mercado brasileiro.
Seja honesto e específico: cite requisitos concretos da vaga, não elogios genéricos.
Pese os requisitos obrigatórios mais do que os desejáveis.
Senioridade é decisiva: compare o nível que a vaga pede (pelo título, anos de experiência e responsabilidades) com o nível do candidato. Vaga um nível acima deve ficar no máximo "parcial"; dois ou mais níveis acima (ex.: candidato Júnior e vaga Sênior) deve ser "fraca" e aparecer em red_flags.
Conflitos com os "deal breakers", localização, modelo de trabalho ou salário do candidato também devem baixar a nota bastante e aparecer em red_flags.
Escala da nota: 85-100 excelente (deve se candidatar já), 70-84 boa, 45-69 parcial, 0-44 fraca.
Salário (salary_estimate): se a vaga informa o salário ou a faixa, use exatamente esse valor com source "informado na vaga". Se não informa, estime uma faixa realista de mercado para o cargo, a senioridade, a cidade e o regime (CLT ou PJ, se der para identificar), com source "estimativa"; em vaga brasileira use BRL mensal, e em vaga internacional paga em outra moeda use a moeda dela. Nunca apresente uma estimativa como valor informado. Em basis, diga em uma frase de onde veio o número. Compare a faixa com a pretensão salarial do candidato em vs_candidate.
Responda sempre em português do Brasil, de forma curta e direta.`;

const MAX_DESCRIPTION_CHARS = 30_000;

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

/** Erro com mensagem pensada para mostrar ao usuário. */
export class AnalysisUnavailable extends Error {}

async function analyzeWithClaude(profile: Profile, job: Job): Promise<Analysis> {
  const description =
    job.description.length > MAX_DESCRIPTION_CHARS
      ? job.description.slice(0, MAX_DESCRIPTION_CHARS) + "\n[descrição cortada por tamanho]"
      : job.description;

  const response = await getClient().messages.parse({
    model: config.ai.model,
    max_tokens: 4096,
    // Esforço baixo: a tarefa é objetiva e isso reduz os tokens de raciocínio.
    output_config: { effort: "low", format: zodOutputFormat(AnalysisSchema) },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `<perfil_do_candidato>\n${profileToText(profile)}\n</perfil_do_candidato>\n\n<vaga>\nTítulo: ${job.title}\nEmpresa: ${job.company}\nLocal: ${job.location}\n\n${description}\n</vaga>\n\nAvalie a compatibilidade.`,
      },
    ],
  });

  recordUsage(job.user_id, job.id, response.model, response.usage.input_tokens, response.usage.output_tokens);

  if (response.stop_reason === "refusal") throw new AnalysisUnavailable("A IA recusou analisar esta vaga.");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`Resposta da IA sem análise (stop_reason: ${response.stop_reason}).`);
  return { ...parsed, score: Math.max(0, Math.min(100, parsed.score)), engine: response.model };
}

/** Analisa uma vaga com IA e salva. Falha com mensagem clara se a IA estiver indisponível. */
export async function analyzeJob(job: Job): Promise<Analysis> {
  if (!config.ai.enabled) {
    throw new AnalysisUnavailable("A IA está desligada: falta a ANTHROPIC_API_KEY no .env do backend.");
  }
  const blocked = limitReached();
  if (blocked) throw new AnalysisUnavailable(`IA pausada: ${blocked}. Volta no dia 1º.`);

  const profile = getProfile(job.user_id);
  const analysis = await analyzeWithClaude(profile, job);

  db.prepare(
    `INSERT OR REPLACE INTO analyses
       (job_id, score, verdict, summary, strengths, gaps, red_flags, application_tips, engine, salary_estimate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.id,
    analysis.score,
    analysis.verdict,
    analysis.summary,
    JSON.stringify(analysis.strengths),
    JSON.stringify(analysis.gaps),
    JSON.stringify(analysis.red_flags),
    analysis.application_tips,
    analysis.engine,
    JSON.stringify(analysis.salary_estimate),
  );

  if (analysis.score >= profile.min_score) {
    await notify(job.user_id, job.id, `Vaga compatível (${analysis.score}%): ${job.title} – ${job.company}`);
  }
  return analysis;
}

/**
 * Usado só pela análise automática (agendador). Analisa com IA as vagas
 * sem análise cuja prévia passou do corte. As abaixo do corte nunca entram aqui.
 */
export async function analyzeAboveCutoff(userId: number, limit = 20) {
  // Nunca gasta IA com vagas fora dos níveis de senioridade que o usuário quer ver.
  const levelFilter = seniorityFilterSql(acceptedLevels(getProfile(userId)));
  const jobs = db
    .prepare(
      `SELECT j.* FROM jobs j LEFT JOIN analyses a ON a.job_id = j.id
       WHERE j.user_id = ? AND a.job_id IS NULL AND j.status != 'descartada' AND j.preview_score >= ?
         AND ${levelFilter} AND ${NOT_BLOCKED_SQL}
       ORDER BY j.preview_score DESC LIMIT ?`,
    )
    .all(userId, config.ai.prefilterMinScore, limit) as Job[];

  let done = 0;
  for (const job of jobs) {
    try {
      await analyzeJob(job);
      done++;
    } catch (err) {
      if (err instanceof AnalysisUnavailable) break; // IA desligada ou limite atingido: para o lote
      console.error(`[análise automática] vaga ${job.id}:`, err);
    }
  }
  return done;
}
