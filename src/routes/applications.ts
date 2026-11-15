import type { FastifyInstance } from "fastify";
import {
  ApplicationPatch,
  getApplication,
  getApplicationEvents,
  removeApplication,
  saveApplication,
  STAGES,
} from "../applications.js";
import { requireAuth } from "../auth.js";
import { db } from "../db.js";

function ownsJob(userId: number, jobId: number) {
  return Boolean(db.prepare("SELECT 1 FROM jobs WHERE id = ? AND user_id = ?").get(jobId, userId));
}

export async function applicationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // O quadro inteiro: as candidaturas de vagas salvas ou com candidatura (descartadas ficam guardadas, fora do quadro).
  app.get("/", async (request) => {
    const userId = request.user.id;
    const items = db
      .prepare(
        `SELECT ap.job_id, ap.stage, ap.applied_at, ap.resume_used, ap.salary_expectation, ap.contact, ap.notes,
                ap.stage_changed_at, ap.updated_at,
                j.title, j.company, j.location, j.url, COALESCE(a.score, j.preview_score) AS score,
                a.job_id IS NOT NULL AS analyzed
         FROM applications ap
         JOIN jobs j ON j.id = ap.job_id
         LEFT JOIN analyses a ON a.job_id = j.id
         WHERE ap.user_id = ? AND j.status IN ('salva', 'candidatado')
         ORDER BY ap.stage_changed_at DESC`,
      )
      .all(userId);

    // CVs já usados, para sugerir no campo (o mais usado primeiro).
    const resumes = db
      .prepare(
        `SELECT resume_used AS name FROM applications
         WHERE user_id = ? AND resume_used != ''
         GROUP BY resume_used ORDER BY COUNT(*) DESC, MAX(updated_at) DESC LIMIT 20`,
      )
      .all(userId) as { name: string }[];

    return {
      stages: STAGES,
      items: items.map((i) => ({ ...i, analyzed: Boolean((i as { analyzed: number }).analyzed) })),
      resumes: resumes.map((r) => r.name),
    };
  });

  // Cria ou atualiza a candidatura de uma vaga (mover de etapa, anotações, CV usado…).
  app.patch<{ Params: { jobId: string } }>("/:jobId", async (request, reply) => {
    const jobId = Number(request.params.jobId);
    if (!ownsJob(request.user.id, jobId)) return reply.code(404).send({ error: "Vaga não encontrada." });
    const patch = ApplicationPatch.parse(request.body);
    const application = saveApplication(request.user.id, jobId, patch);
    return { application, events: getApplicationEvents(jobId) };
  });

  // Tira a vaga do quadro (apaga candidatura, anotações e histórico).
  app.delete<{ Params: { jobId: string } }>("/:jobId", async (request, reply) => {
    const jobId = Number(request.params.jobId);
    if (!ownsJob(request.user.id, jobId) || !getApplication(jobId)) {
      return reply.code(404).send({ error: "Candidatura não encontrada." });
    }
    removeApplication(jobId);
    return { ok: true };
  });
}
