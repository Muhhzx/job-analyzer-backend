import { db } from "./db.js";

export type Profile = {
  user_id: number;
  headline: string;
  seniority: string;
  desired_roles: string;
  skills: string;
  experience: string;
  languages: string;
  locations: string;
  work_mode: string;
  salary_min: string;
  deal_breakers: string;
  resume_text: string;
  search_keywords: string;
  greenhouse_boards: string;
  lever_boards: string;
  /** Níveis de vaga que o usuário quer ver, ex.: "1,2". Vazio = o nível dele e um acima. */
  accepted_levels: string;
  min_score: number;
  /** 0 = só manual; senão, coleta automática a cada N horas. */
  auto_collect_hours: number;
  /** 1 = analisa automaticamente as vagas da coleta automática. */
  auto_analyze: number;
  last_auto_run: string | null;
  updated_at: string;
};

export const PROFILE_TEXT_FIELDS = [
  "headline",
  "seniority",
  "desired_roles",
  "skills",
  "experience",
  "languages",
  "locations",
  "work_mode",
  "salary_min",
  "deal_breakers",
  "resume_text",
  "search_keywords",
  "greenhouse_boards",
  "lever_boards",
  "accepted_levels",
] as const;

export const AUTO_COLLECT_OPTIONS = [0, 6, 12, 24, 48, 168];
export const WORK_MODES = ["qualquer", "remoto", "híbrido", "presencial"];

export function getProfile(userId: number): Profile {
  db.prepare("INSERT OR IGNORE INTO profiles (user_id) VALUES (?)").run(userId);
  return db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(userId) as Profile;
}

export type ProfileUpdate = Partial<
  Pick<Profile, (typeof PROFILE_TEXT_FIELDS)[number] | "min_score" | "auto_collect_hours" | "auto_analyze">
>;

/** Atualiza só os campos enviados. */
export function updateProfile(userId: number, data: ProfileUpdate) {
  getProfile(userId);
  const sets: string[] = [];
  const values: (string | number)[] = [];

  for (const f of PROFILE_TEXT_FIELDS) {
    if (data[f] !== undefined) {
      sets.push(`${f} = ?`);
      values.push(String(data[f]).trim());
    }
  }
  if (data.min_score !== undefined) {
    sets.push("min_score = ?");
    values.push(Math.max(0, Math.min(100, Math.round(data.min_score))));
  }
  if (data.auto_collect_hours !== undefined) {
    sets.push("auto_collect_hours = ?");
    values.push(AUTO_COLLECT_OPTIONS.includes(data.auto_collect_hours) ? data.auto_collect_hours : 0);
  }
  if (data.auto_analyze !== undefined) {
    sets.push("auto_analyze = ?");
    values.push(data.auto_analyze ? 1 : 0);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE profiles SET ${sets.join(", ")} WHERE user_id = ?`).run(...values, userId);
}

/** Lista separada por vírgula, ponto e vírgula ou quebra de linha → array limpo. */
export function splitList(value: string): string[] {
  return value
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isProfileReady(p: Profile): boolean {
  return Boolean(p.skills.trim() || p.resume_text.trim());
}

/** O que falta preencher, na ordem em que vale mais a pena. */
export function profileCompletion(p: Profile) {
  const checks: [string, boolean][] = [
    ["Habilidades", Boolean(p.skills.trim())],
    ["Cargos desejados", Boolean(p.desired_roles.trim())],
    ["Currículo", Boolean(p.resume_text.trim())],
    ["Resumo profissional", Boolean(p.headline.trim())],
    ["Experiência", Boolean(p.experience.trim())],
    ["Localização", Boolean(p.locations.trim())],
    ["Fontes de vagas", Boolean(p.search_keywords.trim() || p.greenhouse_boards.trim() || p.lever_boards.trim())],
  ];
  const done = checks.filter(([, ok]) => ok).length;
  return {
    percent: Math.round((done / checks.length) * 100),
    missing: checks.filter(([, ok]) => !ok).map(([label]) => label),
  };
}

/** Texto do perfil usado pelo analisador. */
export function profileToText(p: Profile): string {
  const lines: [string, string][] = [
    ["Resumo profissional", p.headline],
    ["Senioridade", p.seniority],
    ["Cargos desejados", p.desired_roles],
    ["Habilidades", p.skills],
    ["Experiência", p.experience],
    ["Idiomas", p.languages],
    ["Localizações aceitas", p.locations],
    ["Modelo de trabalho", p.work_mode],
    ["Pretensão salarial mínima", p.salary_min],
    ["Não aceito (deal breakers)", p.deal_breakers],
    ["Currículo", p.resume_text],
  ];
  return lines
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `## ${k}\n${v.trim()}`)
    .join("\n\n");
}
