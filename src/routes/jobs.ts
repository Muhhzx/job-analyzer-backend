import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { analyzeJob, analyzePending, type Job } from "../analyzer.js";
import { requireAuth } from "../auth.js";
import { db } from "../db.js";
import { getProfile, isProfileReady } from "../profile.js";
import { collectJobs, insertJobs } from "../sources/index.js";

const STATUSES = ["nova", "salva", "candidatado", "descartada"] as const;
const FILTERS = ["melhores", "todas", "pendentes", "salva", "candidatado", "descartada"] as const;

const ListQuery = z.object({
  filter: z.enum(FILTERS).default("todas"),
  q: z.string().trim().max(100).optional(),
});

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
};

function parseAnalysis(row: AnalysisRow | undefined | null) {
  if (!row || row.score === null || row.score === undefined) return null;
  return {
    score: row.score,
    verdict: row.verdict,
    summary: row.summary,
    strengths: JSON.parse(row.strengths) as string[],
    gaps: JSON.parse(row.gaps) as string[],
    red_flags: JSON.parse(row.red_flags) as string[],
    application_tips: row.application_tips,
    engine: row.engine,
    analyzed_at: row.analyzed_at,
  };
}

function getOwnedJob(userId: number, jobId: number): Job | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").get(jobId, userId) as Job | undefined;
}

function jobWithAnalysis(job: Job) {
  const analysis = db
    .prepare(
      `SELECT score, verdict, summary, strengths, gaps, red_flags, application_tips, engine, created_at AS analyzed_at
       FROM analyses WHERE job_id = ?`,
    )
    .get(job.id) as AnalysisRow | undefined;
  return { ...job, analysis: parseAnalysis(analysis) };
}

export async function jobRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (request) => {
    const { filter, q } = ListQuery.parse(request.query);
    const profile = getProfile(request.user.id);
    const where: Record<(typeof FILTERS)[number], string> = {
      melhores: "j.status != 'descartada' AND a.score >= :min",
      todas: "j.status != 'descartada'",
      pendentes: "j.status != 'descartada' AND a.job_id IS NULL",
      salva: "j.status = 'salva'",
      candidatado: "j.status = 'candidatado'",
      descartada: "j.status = 'descartada'",
    };
    const search = q ? "AND (j.title LIKE :q OR j.company LIKE :q OR j.location LIKE :q)" : "";
    const rows = db
      .prepare(
        `SELECT j.id, j.title, j.company, j.location, j.source, j.status, j.url, j.created_at,
                a.score, a.verdict, a.summary
         FROM jobs j LEFT JOIN analyses a ON a.job_id = j.id
         WHERE j.user_id = :user AND ${where[filter]} ${search}
         ORDER BY a.score IS NULL, a.score DESC, j.created_at DESC LIMIT 200`,
      )
      // O SQLite recusa parâmetros que a consulta não usa: só envia :min e :q quando aparecem.
      .all({
        user: request.user.id,
        ...(filter === "melhores" ? { min: profile.min_score } : {}),
        ...(q ? { q: `%${q}%` } : {}),
      });

    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN j.status != 'descartada' AND a.score >= ? THEN 1 ELSE 0 END) AS melhores,
           SUM(CASE WHEN j.status != 'descartada' THEN 1 ELSE 0 END) AS todas,
           SUM(CASE WHEN j.status != 'descartada' AND a.job_id IS NULL THEN 1 ELSE 0 END) AS pendentes,
           SUM(CASE WHEN j.status = 'salva' THEN 1 ELSE 0 END) AS salva,
           SUM(CASE WHEN j.status = 'candidatado' THEN 1 ELSE 0 END) AS candidatado,
           SUM(CASE WHEN j.status = 'descartada' THEN 1 ELSE 0 END) AS descartada
         FROM jobs j LEFT JOIN analyses a ON a.job_id = j.id WHERE j.user_id = ?`,
      )
      .get(profile.min_score, request.user.id) as Record<string, number | null>;

    return {
      jobs: rows,
      counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v ?? 0)])),
      minScore: profile.min_score,
    };
  });

  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const job = getOwnedJob(request.user.id, Number(request.params.id));
    if (!job) return reply.code(404).send({ error: "Vaga não encontrada." });
    return { job: jobWithAnalysis(job) };
  });

  app.post("/", async (request) => {
    const body = ManualJobBody.parse(request.body);
    const userId = request.user.id;
    insertJobs(userId, "manual", [{ externalId: crypto.randomUUID(), ...body }]);
    const job = db
      .prepare("SELECT * FROM jobs WHERE user_id = ? AND source = 'manual' ORDER BY id DESC LIMIT 1")
      .get(userId) as Job;
    let warning: string | undefined;
    if (isProfileReady(getProfile(userId))) {
      try {
        await analyzeJob(job, { force: true });
      } catch (err) {
        warning = `Vaga salva, mas a análise falhou: ${(err as Error).message}`;
      }
    }
    return { job: jobWithAnalysis(job), warning };
  });

  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { status } = z.object({ status: z.enum(STATUSES) }).parse(request.body);
    const job = getOwnedJob(request.user.id, Number(request.params.id));
    if (!job) return reply.code(404).send({ error: "Vaga não encontrada." });
    db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, job.id);
    return { job: jobWithAnalysis({ ...job, status }) };
  });

  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const job = getOwnedJob(request.user.id, Number(request.params.id));
    if (!job) return reply.code(404).send({ error: "Vaga não encontrada." });
    db.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/:id/analyze", async (request, reply) => {
    const job = getOwnedJob(request.user.id, Number(request.params.id));
    if (!job) return reply.code(404).send({ error: "Vaga não encontrada." });
    if (!isProfileReady(getProfile(request.user.id))) {
      return reply.code(400).send({ error: "Preencha suas habilidades ou currículo no perfil primeiro." });
    }
    await analyzeJob(job, { force: true });
    return { job: jobWithAnalysis(job) };
  });

  app.post("/collect", async (request, reply) => {
    const profile = getProfile(request.user.id);
    const results = await collectJobs(request.user.id, profile);
    if (results.length === 0) {
      return reply
        .code(400)
        .send({ error: "Nenhuma fonte configurada. Adicione palavras-chave ou empresas em Configurações." });
    }
    return { results, added: results.reduce((s, r) => s + r.added, 0) };
  });

  app.post("/analyze-pending", async (request, reply) => {
    if (!isProfileReady(getProfile(request.user.id))) {
      return reply.code(400).send({ error: "Preencha suas habilidades ou currículo no perfil primeiro." });
    }
    return analyzePending(request.user.id);
  });
}
