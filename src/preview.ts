import { config } from "./config.js";
import { db } from "./db.js";
import { getProfile, splitList, type Profile } from "./profile.js";
import { acceptedLevels, detectJobLevel, LEVELS, PROFILE_LEVEL, type JobLevel } from "./seniority.js";
import { normalize } from "./sources/types.js";

/**
 * Prévia grátis: uma nota por palavras-chave, calculada aqui no servidor,
 * sem IA e sem custo. Toda vaga recebe uma assim que é coletada.
 * A análise com IA (analyzer.ts) só acontece quando o usuário pede.
 */

// ---------- Senioridade (detecção em seniority.ts) ----------

/** Penalidade conforme a distância entre o nível da vaga e o do candidato. */
function seniorityPenalty(gap: number): number {
  if (gap >= 2) return 40; // ex.: Júnior vendo vaga Sênior
  if (gap === 1) return 20; // ex.: Júnior vendo vaga Pleno
  if (gap <= -2) return 10; // vaga bem abaixo do nível (ex.: Sênior vendo estágio)
  return 0;
}

// ---------- Prévia ----------

export type Preview = {
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
  roleMatched: string | null;
  dealBreakers: string[];
  seniority: {
    job: string | null;
    profile: string | null;
    gap: number | null;
    penalty: number;
    /** De onde veio o nível da vaga e o trecho que o indicou. */
    source: JobLevel["source"];
    evidence: string | null;
    /** A vaga está entre os níveis que o usuário quer ver? (null = sem filtro) */
    accepted: boolean | null;
  };
  belowCutoff: boolean;
};

export function computePreview(profile: Profile, job: { title: string; description: string }): Preview {
  const text = normalize(`${job.title}\n${job.description}`);
  const title = normalize(job.title);

  // 1. Habilidades: até 70 pontos (5 encontradas já dão o máximo).
  const skills = splitList(profile.skills);
  const matchedSkills = skills.filter((s) => text.includes(normalize(s)));
  const missingSkills = skills.filter((s) => !matchedSkills.includes(s));
  const skillScore = skills.length ? Math.min(70, (matchedSkills.length / Math.min(skills.length, 5)) * 70) : 30;

  // 2. Cargo: +30 se o título bate com um cargo desejado, senão +10.
  const roleMatched = splitList(profile.desired_roles).find((r) => title.includes(normalize(r))) ?? null;
  const roleScore = roleMatched ? 30 : 10;

  // 3. O que o usuário não aceita: −25 por item encontrado.
  const dealBreakers = splitList(profile.deal_breakers).filter((d) => text.includes(normalize(d)));

  // 4. Senioridade: compara o nível da vaga (título ou anos pedidos) com o do perfil.
  const detected = detectJobLevel(job.title, job.description);
  const jobLevel = detected.level;
  const profileLevel = PROFILE_LEVEL[profile.seniority] ?? null;
  const accepted = acceptedLevels(profile);
  const gap = jobLevel !== null && profileLevel !== null ? jobLevel - profileLevel : null;
  const penalty = gap === null ? 0 : seniorityPenalty(gap);

  const raw = skillScore + roleScore - dealBreakers.length * 25 - penalty;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return {
    score,
    matchedSkills,
    missingSkills,
    roleMatched,
    dealBreakers,
    seniority: {
      job: jobLevel === null ? null : LEVELS[jobLevel],
      profile: profile.seniority || null,
      gap,
      penalty,
      source: detected.source,
      evidence: detected.evidence,
      accepted: jobLevel === null || accepted === null ? null : accepted.includes(jobLevel),
    },
    belowCutoff: score < config.ai.prefilterMinScore,
  };
}

/** Calcula e salva a prévia das vagas do usuário que ainda não têm (ou de todas, se `all`). */
export function refreshPreviews(userId: number, { all = false } = {}) {
  const profile = getProfile(userId);
  const jobs = db
    .prepare(`SELECT id, title, description FROM jobs WHERE user_id = ? ${all ? "" : "AND preview_score IS NULL"}`)
    .all(userId) as { id: number; title: string; description: string }[];

  const update = db.prepare("UPDATE jobs SET preview_score = ?, preview = ?, seniority_level = ? WHERE id = ?");
  for (const job of jobs) {
    const p = computePreview(profile, job);
    const level = detectJobLevel(job.title, job.description).level;
    update.run(p.score, JSON.stringify(p), level, job.id);
  }
  return jobs.length;
}
