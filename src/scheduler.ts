import { analyzeAboveCutoff } from "./analyzer.js";
import { db } from "./db.js";
import { notify } from "./notify.js";
import { getProfile } from "./profile.js";
import { refreshPreviews } from "./preview.js";
import { collectJobs } from "./sources/index.js";

const CHECK_EVERY_MS = 5 * 60 * 1000;

/** Roda a busca (e a análise com IA, se o usuário ligou) para quem está no horário. */
export async function runDueJobs() {
  const due = db
    .prepare(
      `SELECT user_id FROM profiles
       WHERE auto_collect_hours > 0
         AND (last_auto_run IS NULL
              OR last_auto_run <= datetime('now', '-' || auto_collect_hours || ' hours'))`,
    )
    .all() as { user_id: number }[];

  for (const { user_id } of due) {
    // Marca antes de rodar para não repetir se demorar mais que o intervalo.
    db.prepare("UPDATE profiles SET last_auto_run = datetime('now') WHERE user_id = ?").run(user_id);
    try {
      const profile = getProfile(user_id);
      const results = await collectJobs(user_id, profile);
      const added = results.reduce((s, r) => s + r.added, 0);
      if (added === 0) continue;

      refreshPreviews(user_id); // nota grátis em todas as vagas novas
      // IA só se o usuário ligou a análise automática, e só nas que passaram do corte.
      const analyzed = profile.auto_analyze ? await analyzeAboveCutoff(user_id) : 0;
      await notify(
        user_id,
        null,
        `Busca automática: ${added} vagas novas${analyzed ? `, ${analyzed} analisadas com IA` : ""}.`,
      );
    } catch (err) {
      console.error(`[agendador] usuário ${user_id}:`, err);
    }
  }
}

export function startScheduler() {
  setInterval(() => void runDueJobs(), CHECK_EVERY_MS);
  console.log("[agendador] ligado: verifica a cada 5 minutos quem tem busca automática no horário");
}
