import { z } from "zod";
import { db } from "./db.js";

/**
 * Kanban de candidaturas.
 * Cada vaga que o usuário acompanha tem uma linha em `applications` com a etapa atual e os
 * dados da candidatura. `application_events` guarda cada mudança de etapa (o histórico).
 *
 * A situação da vaga (`jobs.status`) acompanha o quadro: "salva" na primeira etapa e
 * "candidatado" nas outras. Assim a lista de vagas, os filtros e o painel continuam certos.
 */
export const STAGES = ["salva", "candidatei", "teste", "entrevista", "proposta", "encerrada"] as const;
export type Stage = (typeof STAGES)[number];

export type Application = {
  job_id: number;
  stage: Stage;
  applied_at: string | null;
  resume_used: string;
  salary_expectation: string;
  contact: string;
  notes: string;
  stage_changed_at: string;
  created_at: string;
  updated_at: string;
};

export type ApplicationEvent = { stage: Stage; created_at: string };

/** Campos que o usuário pode editar. Todos opcionais: só muda o que vier. */
export const ApplicationPatch = z.object({
  stage: z.enum(STAGES).optional(),
  applied_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.")
    .nullable()
    .optional(),
  resume_used: z.string().trim().max(200).optional(),
  salary_expectation: z.string().trim().max(100).optional(),
  contact: z.string().trim().max(500).optional(),
  notes: z.string().max(5000).optional(),
});
export type ApplicationPatch = z.infer<typeof ApplicationPatch>;

/** Hoje no fuso do servidor, como AAAA-MM-DD (toISOString daria a data em UTC, que vira o dia às 21h no Brasil). */
const today = () => new Date().toLocaleDateString("sv-SE");
const jobStatusFor = (stage: Stage) => (stage === "salva" ? "salva" : "candidatado");

export function getApplication(jobId: number): Application | undefined {
  return db
    .prepare(
      `SELECT job_id, stage, applied_at, resume_used, salary_expectation, contact, notes,
              stage_changed_at, created_at, updated_at
       FROM applications WHERE job_id = ?`,
    )
    .get(jobId) as Application | undefined;
}

export function getApplicationEvents(jobId: number): ApplicationEvent[] {
  return db
    .prepare("SELECT stage, created_at FROM application_events WHERE job_id = ? ORDER BY id")
    .all(jobId) as ApplicationEvent[];
}

/**
 * Cria a candidatura (se ainda não existir) ou aplica as mudanças.
 * Mudar de etapa grava no histórico, atualiza `jobs.status` e, ao sair de "salva"
 * sem data de candidatura, preenche a data com hoje.
 */
export function saveApplication(userId: number, jobId: number, patch: ApplicationPatch): Application {
  const current = getApplication(jobId);
  const stage = patch.stage ?? current?.stage ?? "salva";
  const stageChanged = !current || current.stage !== stage;

  let appliedAt = patch.applied_at !== undefined ? patch.applied_at : (current?.applied_at ?? null);
  if (stage !== "salva" && appliedAt === null && patch.applied_at === undefined) appliedAt = today();

  // O SQLite recusa parâmetros que a consulta não usa: `user` só entra no INSERT.
  const values = {
    job: jobId,
    stage,
    applied: appliedAt,
    resume: patch.resume_used ?? current?.resume_used ?? "",
    salary: patch.salary_expectation ?? current?.salary_expectation ?? "",
    contact: patch.contact ?? current?.contact ?? "",
    notes: patch.notes ?? current?.notes ?? "",
  };

  db.exec("BEGIN");
  try {
    if (current) {
      db.prepare(
        `UPDATE applications SET stage = :stage, applied_at = :applied, resume_used = :resume,
           salary_expectation = :salary, contact = :contact, notes = :notes, updated_at = datetime('now')
           ${stageChanged ? ", stage_changed_at = datetime('now')" : ""}
         WHERE job_id = :job`,
      ).run(values);
    } else {
      db.prepare(
        `INSERT INTO applications (job_id, user_id, stage, applied_at, resume_used, salary_expectation, contact, notes)
         VALUES (:job, :user, :stage, :applied, :resume, :salary, :contact, :notes)`,
      ).run({ ...values, user: userId });
    }
    if (stageChanged) db.prepare("INSERT INTO application_events (job_id, stage) VALUES (?, ?)").run(jobId, stage);
    db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(jobStatusFor(stage), jobId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return getApplication(jobId)!;
}

/**
 * Chamado quando a situação da vaga muda pela tela da vaga ("Salvar", "Me candidatei").
 * Coloca a vaga no quadro ou avança de "salva" para "candidatei". Etapas mais à frente
 * (teste, entrevista…) não voltam para trás por causa disso.
 * Ao descartar ou desfazer, a candidatura fica guardada (com as anotações), só some do quadro.
 */
export function syncApplicationWithStatus(userId: number, jobId: number, status: string) {
  const current = getApplication(jobId);
  if (status === "salva" && !current) saveApplication(userId, jobId, { stage: "salva" });
  if (status === "candidatado" && (!current || current.stage === "salva")) {
    saveApplication(userId, jobId, { stage: "candidatei" });
  }
  // Uma candidatura guardada volta ao quadro na etapa em que estava.
  if ((status === "salva" || status === "candidatado") && current && current.stage !== "salva") {
    db.prepare("UPDATE jobs SET status = 'candidatado' WHERE id = ?").run(jobId);
  }
}

/** Tira a vaga do quadro: apaga a candidatura e o histórico, e a vaga volta a ser "nova". */
export function removeApplication(jobId: number) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM applications WHERE job_id = ?").run(jobId);
    db.prepare("UPDATE jobs SET status = 'nova' WHERE id = ?").run(jobId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
