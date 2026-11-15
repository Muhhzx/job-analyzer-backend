import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AnalysisUnavailable, analyzeJob, type Analysis, type Job } from "../analyzer.js";
import { getApplication, getApplicationEvents, syncApplicationWithStatus } from "../applications.js";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { getProfile } from "../profile.js";
import { refreshPreviews, type Preview } from "../preview.js";
import { acceptedLevels, seniorityFilterSql } from "../seniority.js";
import { collectJobs, insertJobs } from "../sources/index.js";

const STATUSES = ["nova", "salva", "candidatado", "descartada"] as const;
const FILTERS = ["melhores", "todas", "nova", "salva", "candidatado", "descartada", "ia"] as const;
type Filter = (typeof FILTERS)[number];

/**
 * Nota que vale para ordenar e filtrar: a da IA, se existir; senão, a prévia grátis.
 * Usada em várias consultas, por isso fica numa constante.
 */
const EFFECTIVE_SCORE = "COALESCE(a.score, j.preview_score)";

/**
 * O que aparece na tela: nota a partir de config.minVisibleScore E nível de senioridade
 * entre os aceitos pelo usuário. O resto fica salvo, mas escondido.
 */
function visibleSql(levels: number[] | null) {
  return `${EFFECTIVE_SCORE} >= ${Number(config.minVisibleScore)} AND ${seniorityFilterSql(levels)}`;
}

const ListQuery = z.object({
  filter: z.enum(FILTERS).default("todas"),
  q: z.string().trim().max(100).optional(),
  company: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(20),
});

/** Condição SQL de cada filtro de situação. `:min` é a nota mínima para "Melhores". */
const FILTER_SQL: Record<Filter, string> = {
  melhores: `j.status != 'descartada' AND ${EFFECTIVE_SCORE} >= :min`,
  todas: "j.status != 'descartada'",
  nova: "j.status = 'nova'",
  salva: "j.status = 'salva'",
  candidatado: "j.status = 'candidatado'",
  descartada: "j.status = 'descartada'",
  ia: "j.status != 'descartada' AND a.job_id IS NOT NULL",
};

/**
 * Junta as condições do WHERE e os parâmetros delas no mesmo lugar.
 * O SQLite recusa parâmetros que a consulta não usa, então cada condição
 * só adiciona o parâmetro quando ela própria entra na consulta.
 */
function buildWhere(
  userId: number,
  opts: { filter?: Filter; q?: string; company?: string; minScore: number; levels: number[] | null },
) {
  const conditions = ["j.user_id = :user", visibleSql(opts.levels)];
  const params: Record<string, string | number> = { user: userId };

  if (opts.filter) {
    conditions.push(FILTER_SQL[opts.filter]);
    if (opts.filter === "melhores") params.min = opts.minScore;
  }
  if (opts.q) {
    conditions.push("(j.title LIKE :q OR j.company LIKE :q OR j.location LIKE :q)");
    params.q = `%${opts.q}%`;
  }
  if (opts.company) {
    conditions.push("j.company = :company");
    params.company = opts.company;
  }
  return { sql: conditions.join(" AND "), params };
}

const FROM = "FROM jobs j LEFT JOIN analyses a ON a.job_id = j.id";

const ManualJobBody = z.object({
  title: z.string().trim().min(1, "Informe o título da vaga."),
  company: z.string().trim().default(""),
  location: z.string().trim().default(""),
  url: z.string().trim().default(""),
  description: z.string().trim().min(50, "Cole a descrição completa da vaga."),
});

type AnalysisRow = {
  score: number;
  verdict: string;
  summary: string;
  strengths: string;
  gaps: string;
  red_flags: string;
  application_tips: string;
  engine: string;
  analyzed_at: string;
  salary_estimate: string | null;
};

function getOwnedJob(userId: number, jobId: number): Job | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").get(jobId, userId) as Job | undefined;
}

/** Monta a resposta da vaga: dados + prévia grátis + análise de IA (se houver). */
function jobDetail(jobId: number) {
  const { preview, preview_score, ...job } = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Job;
  const row = db
    .prepare(
      `SELECT score, verdict, summary, strengths, gaps, red_flags, application_tips, engine, salary_estimate,
              created_at AS analyzed_at
       FROM analyses WHERE job_id = ?`,
    )
    .get(jobId) as AnalysisRow | undefined;

  return {
    ...job,
    preview: preview ? (JSON.parse(preview) as Preview) : null,
    analysis: row
      ? {
          ...row,
          strengths: JSON.parse(row.strengths) as string[],
          gaps: JSON.parse(row.gaps) as string[],
          red_flags: JSON.parse(row.red_flags) as string[],
          // Análises antigas (antes da estimativa de salário) vêm com null.
          salary_estimate: row.salary_estimate
            ? (JSON.parse(row.salary_estimate) as Analysis["salary_estimate"])
            : null,
        }
      : null,
    application: getApplication(jobId) ?? null,
    applicationEvents: getApplicationEvents(jobId),
    aiEnabled: config.ai.enabled,
    prefilterMinScore: config.ai.prefilterMinScore,
  };
}

export async function jobRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (request) => {
    const { filter, q, company, page, pageSize } = ListQuery.parse(request.query);
    const userId = request.user.id;
    const profile = getProfile(userId);
    const minScore = profile.min_score;
    const levels = acceptedLevels(profile);

    // 1. A página de vagas, com todos os filtros.
    const list = buildWhere(userId, { filter, q, company, minScore, levels });
    const { total } = db.prepare(`SELECT COUNT(*) AS total ${FROM} WHERE ${list.sql}`).get(list.params) as {
      total: number;
    };
    const totalPages = Math.max(1, Math.ceil(Number(total) / pageSize));
    const currentPage = Math.min(page, totalPages); // página além da última → última
    const jobs = db
      .prepare(
        `SELECT j.id, j.title, j.company, j.location, j.source, j.status, j.url, j.created_at,
                j.preview_score, a.score, a.verdict, a.summary
         ${FROM} WHERE ${list.sql}
         ORDER BY ${EFFECTIVE_SCORE} DESC, j.created_at DESC
         LIMIT :limit OFFSET :offset`,
      )
      .all({ ...list.params, limit: pageSize, offset: (currentPage - 1) * pageSize });

    // 2. Contagem por situação (os cartões de controle), respeitando busca e empresa.
    const base = buildWhere(userId, { q, company, minScore, levels });
    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN j.status != 'descartada' AND ${EFFECTIVE_SCORE} >= :min THEN 1 ELSE 0 END) AS melhores,
           SUM(CASE WHEN j.status != 'descartada' THEN 1 ELSE 0 END) AS todas,
           SUM(CASE WHEN j.status = 'nova' THEN 1 ELSE 0 END) AS nova,
           SUM(CASE WHEN j.status = 'salva' THEN 1 ELSE 0 END) AS salva,
           SUM(CASE WHEN j.status = 'candidatado' THEN 1 ELSE 0 END) AS candidatado,
           SUM(CASE WHEN j.status = 'descartada' THEN 1 ELSE 0 END) AS descartada,
           SUM(CASE WHEN j.status != 'descartada' AND a.job_id IS NOT NULL THEN 1 ELSE 0 END) AS ia
         ${FROM} WHERE ${base.sql}`,
      )
      .get({ ...base.params, min: minScore }) as Record<string, number | null>;

    // 3. Empresas para o filtro: as que aparecem na situação e busca atuais (sem filtrar por empresa).
    const forCompanies = buildWhere(userId, { filter, q, minScore, levels });
    const companies = db
      .prepare(
        `SELECT j.company AS name, COUNT(*) AS count ${FROM}
         WHERE ${forCompanies.sql} AND j.company != ''
         GROUP BY j.company ORDER BY count DESC, j.company`,
      )
      .all(forCompanies.params);

    return {
      jobs,
      total: Number(total),
      page: currentPage,
      pageSize,
      totalPages,
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v ?? 0)])),
      companies,
      minScore,
      minVisibleScore: config.minVisibleScore,
      prefilterMinScore: config.ai.prefilterMinScore,
    };
  });

  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const job = getOwnedJob(request.user.id, Number(request.params.id));
    if (!job) return reply.code(404).send({ error: "Vaga não encontrada." });
    return { job: jobDetail(job.id) };
  });

  // Vaga colada pelo usuário: recebe só a prévia grátis. A IA continua sendo escolha dele.
  app.post("/", async (request) => {
    const body = ManualJobBody.parse(request.body);
    const userId = request.user.id;
    insertJobs(userId, "manual", [{ externalId: crypto.randomUUID(), ...body }]);
    refreshPreviews(userId);
    const { id } = db
      .prepare("SELECT id FROM jobs WHERE user_id = ? AND source = 'manual' ORDER BY id DESC LIMIT 1")
      .get(userId) as { id: number };
    return { job: jobDetail(id) };
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { status } = z.object({ status: z.enum(STATUSES) }).parse(request.body);
    const job = getOwnedJob(request.user.id, Number(request.params.id));
    if (!job) return reply.code(404).send({ error: "Vaga não encontrada." });
    db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, job.id);
    syncApplicationWithStatus(request.user.id, job.id, status);
    return { job: jobDetail(job.id) };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const job = getOwnedJob(request.user.id, Number(request.params.id));
    if (!job) return reply.code(404).send({ error: "Vaga não encontrada." });
    db.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
    return { ok: true };
  });

  // Análise com IA de UMA vaga. O frontend só chama depois da confirmação do usuário.
  app.post<{ Params: { id: string } }>("/:id/analyze", async (request, reply) => {
    const job = getOwnedJob(request.user.id, Number(request.params.id));
    if (!job) return reply.code(404).send({ error: "Vaga não encontrada." });
    try {
      await analyzeJob(job);
    } catch (err) {
      if (err instanceof AnalysisUnavailable) return reply.code(400).send({ error: err.message });
      throw err;
    }
    return { job: jobDetail(job.id) };
  });

  app.post("/collect", async (request, reply) => {
    const userId = request.user.id;
    // Uma busca por usuário de cada vez: dois cliques (ou duas abas) não disparam duas buscas.
    if (collectingUsers.has(userId)) {
      return reply.code(409).send({ error: "Já existe uma busca em andamento. Aguarde ela terminar." });
    }
    collectingUsers.add(userId);
    try {
      return await collect(userId, reply);
    } finally {
      collectingUsers.delete(userId);
    }
  });
}

/** Usuários com uma busca em andamento agora (vale para um servidor só; veja o README). */
const collectingUsers = new Set<number>();

async function collect(userId: number, reply: FastifyReply) {
  // Guarda o maior id antes da busca: tudo acima dele é vaga nova desta busca.
  const { lastId } = db.prepare("SELECT COALESCE(MAX(id), 0) AS lastId FROM jobs").get() as { lastId: number };

  const results = await collectJobs(userId, getProfile(userId));
  if (results.length === 0) {
    return reply
      .code(400)
      .send({ error: "Nenhuma fonte configurada. Adicione palavras-chave ou empresas em Configurações." });
  }
  refreshPreviews(userId); // as vagas novas já saem com a nota grátis

  // Das vagas novas, quantas passam nos filtros de nota e de senioridade (o mesmo da lista).
  const levels = acceptedLevels(getProfile(userId));
  const { added, visible, wrongLevel } = db
    .prepare(
      `SELECT COUNT(*) AS added,
                SUM(CASE WHEN ${visibleSql(levels)} THEN 1 ELSE 0 END) AS visible,
                SUM(CASE WHEN NOT ${seniorityFilterSql(levels)} THEN 1 ELSE 0 END) AS wrongLevel
         ${FROM} WHERE j.user_id = ? AND j.id > ?`,
    )
    .get(userId, lastId) as { added: number; visible: number | null; wrongLevel: number | null };

  return {
    results,
    added: Number(added),
    visible: Number(visible ?? 0),
    hidden: Number(added) - Number(visible ?? 0),
    hiddenByLevel: Number(wrongLevel ?? 0),
    minVisibleScore: config.minVisibleScore,
  };
}
