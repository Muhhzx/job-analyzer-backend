import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { config } from "../config.js";
import { db } from "../db.js";
import { listNotifications, markAllRead, unreadCount } from "../notify.js";
import { refreshPreviews } from "../preview.js";
import { acceptedLevels, seniorityFilterSql } from "../seniority.js";
import { getProfile, profileCompletion } from "../profile.js";
import { SOURCES } from "../sources/index.js";
import { monthUsage } from "../usage.js";

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/dashboard", async (request) => {
    const userId = request.user.id;
    refreshPreviews(userId);
    const profile = getProfile(userId);
    // Mesmo filtro de senioridade da lista de vagas.
    const levelFilter = seniorityFilterSql(acceptedLevels(profile));

    // Nota que vale: a da IA, se existir; senão, a prévia grátis.
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(a.job_id) AS analyzed,
                SUM(CASE WHEN COALESCE(a.score, j.preview_score) >= ? AND j.status != 'descartada' THEN 1 ELSE 0 END) AS good,
                SUM(CASE WHEN j.status = 'salva' THEN 1 ELSE 0 END) AS saved,
                SUM(CASE WHEN j.status = 'candidatado' THEN 1 ELSE 0 END) AS applied
         FROM jobs j LEFT JOIN analyses a ON a.job_id = j.id
         WHERE j.user_id = ? AND COALESCE(a.score, j.preview_score) >= ? AND ${levelFilter}`,
      )
      .get(profile.min_score, userId, config.minVisibleScore) as Record<string, number | null>;

    const topJobs = db
      .prepare(
        `SELECT j.id, j.title, j.company, j.location, j.source, j.status, j.preview_score, a.score, a.verdict, a.summary
         FROM jobs j LEFT JOIN analyses a ON a.job_id = j.id
         WHERE j.user_id = ? AND j.status NOT IN ('descartada', 'candidatado')
           AND COALESCE(a.score, j.preview_score) >= ? AND ${levelFilter}
         ORDER BY COALESCE(a.score, j.preview_score) DESC, j.created_at DESC LIMIT 5`,
      )
      .all(userId, config.minVisibleScore);

    const nextRun =
      profile.auto_collect_hours > 0
        ? profile.last_auto_run
          ? new Date(new Date(profile.last_auto_run + "Z").getTime() + profile.auto_collect_hours * 3600_000).toISOString()
          : "em breve"
        : null;

    return {
      stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Number(v ?? 0)])),
      minScore: profile.min_score,
      topJobs,
      completion: profileCompletion(profile),
      sourcesConfigured: SOURCES.filter((s) => s.isConfigured(profile)).length,
      automation: {
        collectHours: profile.auto_collect_hours,
        autoAnalyze: Boolean(profile.auto_analyze),
        lastRun: profile.last_auto_run ? profile.last_auto_run + "Z" : null,
        nextRun,
      },
      ai: {
        enabled: config.ai.enabled,
        model: config.ai.model,
        prefilterMinScore: config.ai.prefilterMinScore,
        usage: monthUsage(),
      },
    };
  });

  app.get("/sources", async (request) => {
    const profile = getProfile(request.user.id);
    return {
      sources: SOURCES.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        field: s.profileField,
        configured: s.isConfigured(profile),
      })),
    };
  });

  app.get("/notifications", async (request) => ({
    notifications: listNotifications(request.user.id),
    unread: unreadCount(request.user.id),
  }));

  app.post("/notifications/read", async (request) => {
    markAllRead(request.user.id);
    return { ok: true };
  });
}
