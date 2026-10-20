import { normalize } from "./sources/types.js";

/**
 * Senioridade: descobre o nível que a vaga pede e decide se ela entra no
 * filtro do usuário. Os textos chegam normalizados (minúsculos, sem acento).
 */

export const LEVELS = ["Estágio", "Júnior", "Pleno", "Sênior", "Especialista"] as const;

/** Nível escolhido no perfil → índice em LEVELS. */
export const PROFILE_LEVEL: Record<string, number> = {
  Estágio: 0,
  Júnior: 1,
  Pleno: 2,
  Sênior: 3,
  Especialista: 4,
  Liderança: 4,
};

// Palavras de nível no título.
const TITLE_WORDS: [RegExp, number][] = [
  [/\b(estagi\w*|intern(ship)?|trainee|aprendiz)\b/, 0],
  [/\b(junior|jr)\b/, 1],
  // Sem "pl" sozinho: confundiria com "PL/SQL".
  [/\b(pleno|mid|middle|mid-level)\b/, 2],
  [/\b(senior|sr)\b/, 3],
  [/\b(staff|principal|especialista|specialist|lead|lider|head|arquitet\w*|architect|coordenador\w*|gerente|manager)\b/, 4],
];

// Numeração depois do cargo: "Desenvolvedor II", "Software Engineer III", "Analista de Sistemas I".
const ROLE = "(?:desenvolvedor|developer|engenheir\\w*|engineer|analista|programador|dev)(?:\\(a\\))?";
const ROMAN_AFTER_ROLE = new RegExp(`${ROLE}(?: de [a-z]+)?(?: [a-z]+)?\\s+(iv|iii|ii|i)\\b`);
const DIGIT_AFTER_ROLE = new RegExp(`${ROLE}\\s+([1-4])\\b`);
const NUMERAL_LEVEL: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, "1": 1, "2": 2, "3": 3, "4": 4 };

// Anos de experiência na descrição: "5+ anos de experiência", "3 years of experience",
// "experiência mínima de 4 anos".
const YEARS_PATTERNS = [
  /(\d{1,2})\s*\+?\s*anos? de experiencia/g,
  /experiencia (?:minima |comprovada |previa )?de (\d{1,2})\s*\+?\s*anos?/g,
  /(\d{1,2})\s*\+?\s*(?:years?|yrs?) of (?:professional |relevant |hands-on )?experience/g,
];

function levelFromYears(years: number): number {
  if (years >= 5) return 3; // Sênior
  if (years >= 3) return 2; // Pleno
  return 1; // Júnior
}

export type JobLevel = {
  /** Índice em LEVELS, ou null se a vaga não indica o nível. */
  level: number | null;
  /** De onde veio a informação. */
  source: "título" | "experiência pedida" | null;
  /** O trecho que indicou o nível (para mostrar ao usuário). */
  evidence: string | null;
};

export function detectJobLevel(title: string, description = ""): JobLevel {
  const t = normalize(title);

  // 1. Título: junta todos os níveis citados e fica com o MENOR.
  //    "Desenvolvedor Pleno/Sênior" aceita Pleno, então conta como Pleno.
  const found: { level: number; evidence: string }[] = [];
  for (const [pattern, level] of TITLE_WORDS) {
    const m = t.match(pattern);
    if (m) found.push({ level, evidence: m[0] });
  }
  const roman = t.match(ROMAN_AFTER_ROLE) ?? t.match(DIGIT_AFTER_ROLE);
  if (roman) found.push({ level: NUMERAL_LEVEL[roman[1]!]!, evidence: roman[0] });

  if (found.length) {
    const lowest = found.reduce((a, b) => (b.level < a.level ? b : a));
    return { level: lowest.level, source: "título", evidence: lowest.evidence };
  }

  // 2. Sem nível no título: procura anos de experiência na descrição (fica com o menor número).
  const d = normalize(description);
  let minYears: { years: number; evidence: string } | null = null;
  for (const pattern of YEARS_PATTERNS) {
    for (const m of d.matchAll(pattern)) {
      const years = Number(m[1]);
      if (years > 0 && years <= 20 && (!minYears || years < minYears.years)) minYears = { years, evidence: m[0] };
    }
  }
  if (minYears) return { level: levelFromYears(minYears.years), source: "experiência pedida", evidence: minYears.evidence };

  return { level: null, source: null, evidence: null };
}

/**
 * Níveis de vaga que o usuário quer ver.
 * - Escolheu no perfil ("1,2")  → exatamente esses.
 * - Não escolheu                → o nível dele e um acima (Júnior → Júnior e Pleno).
 * - Sem senioridade no perfil   → null (mostra todos).
 */
export function acceptedLevels(profile: { seniority: string; accepted_levels: string }): number[] | null {
  const chosen = profile.accepted_levels
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "") // cuidado: Number("") é 0, e viraria "Estágio"
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n < LEVELS.length);
  if (chosen.length) return chosen;

  const own = PROFILE_LEVEL[profile.seniority];
  if (own === undefined) return null;
  return [own, Math.min(own + 1, LEVELS.length - 1)].filter((v, i, a) => a.indexOf(v) === i);
}

/**
 * Trecho SQL do filtro de senioridade. Vagas sem nível identificado sempre aparecem,
 * para você não perder oportunidades. Os níveis são números validados, por isso
 * podem ir direto no SQL.
 */
export function seniorityFilterSql(levels: number[] | null): string {
  if (!levels) return "1 = 1";
  return `(j.seniority_level IS NULL OR j.seniority_level IN (${levels.map(Number).join(", ")}))`;
}
