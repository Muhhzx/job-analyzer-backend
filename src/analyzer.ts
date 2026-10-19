import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import { notify } from "./notify.js";
import { getProfile, profileToText, splitList, type Profile } from "./profile.js";
import { normalize } from "./sources/types.js";
import { limitReached, recordUsage } from "./usage.js";

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
};

const AnalysisSchema = z.object({
  score: z.number().int().describe("Compatibilidade de 0 a 100 entre o candidato e a vaga"),
  verdict: z.enum(["excelente", "boa", "parcial", "fraca"]),
  summary: z.string().describe("2 a 3 frases explicando a nota"),
  strengths: z.array(z.string()).describe("Requisitos da vaga que o candidato atende"),
  gaps: z.array(z.string()).describe("Requisitos que faltam ou estão fracos"),
  red_flags: z.array(z.string()).describe("Conflitos com deal breakers, local, modelo de trabalho, salário etc."),
  application_tips: z.string().describe("Como o candidato deve se posicionar ao se candidatar"),
});

export type Analysis = z.infer<typeof AnalysisSchema> & { engine: string };

const SYSTEM_PROMPT = `Você é um recrutador técnico experiente que avalia a compatibilidade entre um candidato e uma vaga.
Seja honesto e específico: cite requisitos concretos da vaga, não elogios genéricos.
Pese os requisitos obrigatórios mais do que os desejáveis. Conflitos com os "deal breakers", localização, modelo de trabalho ou salário do candidato devem baixar a nota bastante e aparecer em red_flags.
Escala da nota: 85-100 excelente (deve se candidatar já), 70-84 boa, 45-69 parcial, 0-44 fraca.
Responda sempre em português do Brasil, de forma curta e direta.`;

const MAX_DESCRIPTION_CHARS = 30_000;

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

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

  if (response.stop_reason === "refusal") throw new Error("A IA recusou analisar esta vaga.");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`Resposta da IA sem análise (stop_reason: ${response.stop_reason}).`);
  return { ...parsed, score: Math.max(0, Math.min(100, parsed.score)), engine: response.model };
}

/** Análise grátis por palavras-chave. Também serve de pré-filtro para a IA. */
function analyzeWithKeywords(profile: Profile, job: Job): Analysis {
  const text = normalize(`${job.title}\n${job.description}`);
  const skills = splitList(profile.skills);
  const strengths = skills.filter((s) => text.includes(normalize(s)));
  const roles = splitList(profile.desired_roles);
  const roleMatch = roles.some((r) => normalize(job.title).includes(normalize(r)));
  const flags = splitList(profile.deal_breakers).filter((d) => text.includes(normalize(d)));

  const skillScore = skills.length ? (strengths.length / Math.min(skills.length, 5)) * 70 : 30;
  let score = Math.round(Math.min(70, skillScore) + (roleMatch ? 30 : 10) - flags.length * 25);
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    verdict: score >= 85 ? "excelente" : score >= 70 ? "boa" : score >= 45 ? "parcial" : "fraca",
    summary: `${strengths.length} das suas habilidades aparecem na vaga${roleMatch ? " e o título bate com um cargo desejado" : ""}.`,
    strengths,
    gaps: [],
    red_flags: flags.map((f) => `A vaga menciona "${f}", que está nos seus deal breakers`),
    application_tips: "",
    engine: "palavras-chave",
  };
}

const keywordOnly = (base: Analysis, reason: string): Analysis => ({
  ...base,
  summary: `${base.summary} ${reason}`,
  engine: "palavras-chave",
});

/**
 * Decide quem analisa a vaga: palavras-chave (grátis) ou IA.
 * `force` pula o pré-filtro (quando o usuário pede a análise de uma vaga específica),
 * mas o limite mensal vale sempre.
 */
export async function analyzeJob(job: Job, { force = false } = {}): Promise<Analysis> {
  const profile = getProfile(job.user_id);
  const keyword = analyzeWithKeywords(profile, job);
  let analysis: Analysis;

  if (!config.ai.enabled) {
    analysis = keywordOnly(keyword, "Configure a ANTHROPIC_API_KEY para a análise com IA.");
  } else if (!force && keyword.score < config.ai.prefilterMinScore) {
    analysis = keywordOnly(keyword, "Pouca compatibilidade no pré-filtro, então a IA não foi usada (sem custo).");
  } else {
    const blocked = limitReached();
    analysis = blocked ? keywordOnly(keyword, `IA pausada: ${blocked}.`) : await analyzeWithClaude(profile, job);
  }

  db.prepare(
    `INSERT OR REPLACE INTO analyses (job_id, score, verdict, summary, strengths, gaps, red_flags, application_tips, engine)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );

  if (analysis.score >= profile.min_score) {
    await notify(job.user_id, job.id, `Vaga compatível (${analysis.score}%): ${job.title} – ${job.company}`);
  }
  return analysis;
}

const PENDING_WHERE = "j.user_id = ? AND a.job_id IS NULL AND j.status != 'descartada'";

/** Analisa as vagas ainda sem análise, em lotes pequenos para controlar custo. */
export async function analyzePending(userId: number, limit = 10) {
  const jobs = db
    .prepare(
      `SELECT j.* FROM jobs j LEFT JOIN analyses a ON a.job_id = j.id
       WHERE ${PENDING_WHERE} ORDER BY j.created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as Job[];

  let done = 0;
  let withAi = 0;
  const errors: string[] = [];
  // Algumas em paralelo para não demorar demais.
  for (let i = 0; i < jobs.length; i += 3) {
    const batch = jobs.slice(i, i + 3);
    const results = await Promise.allSettled(batch.map((j) => analyzeJob(j)));
    results.forEach((r, k) => {
      if (r.status === "fulfilled") {
        done++;
        if (r.value.engine !== "palavras-chave") withAi++;
      } else errors.push(`${batch[k].title}: ${(r.reason as Error).message}`);
    });
  }
  return { done, withAi, errors, remaining: countPending(userId) };
}

export function countPending(userId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM jobs j LEFT JOIN analyses a ON a.job_id = j.id WHERE ${PENDING_WHERE}`)
    .get(userId) as { n: number };
  return Number(row.n);
}
