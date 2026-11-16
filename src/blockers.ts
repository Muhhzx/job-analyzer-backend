import { splitList, type Profile } from "./profile.js";
import { requiredYears } from "./seniority.js";
import { normalize } from "./sources/types.js";

/**
 * Filtros de bloqueio: diferente do "não aceito" (que só tira 25 pontos da nota),
 * um bloqueio ESCONDE a vaga. Serve para o que torna a vaga impossível, não só ruim:
 * exigir residência em outro país, security clearance, anos de experiência demais…
 *
 * As vagas bloqueadas continuam salvas (a próxima busca não as traz de novo) e
 * aparecem no filtro "Bloqueadas", com o motivo, para o usuário conferir se o filtro errou.
 */

/** Bloqueios prontos. Os termos são comparados sem acento e em minúsculas. */
export const BLOCK_PRESETS = {
  residencia: {
    label: "Exige residência, cidadania ou visto que não tenho",
    terms: [
      "permanent resident",
      "permanent residency",
      "citizenship required",
      "must be a citizen",
      "must be a us citizen",
      "us citizens only",
      "must have the right to work",
      "must be authorized to work",
      "must be legally authorized",
      "no visa sponsorship",
      "unable to sponsor",
      "not able to sponsor",
      "will not sponsor",
      "does not sponsor",
      "cannot sponsor",
      "nz citizen",
      "australian citizen",
      "residencia permanente",
      "permiso de trabajo en vigor",
      "residencia legal en espana",
    ],
  },
  clearance: {
    label: "Exige security clearance (governo, defesa)",
    terms: ["security clearance", "clearance required", "baseline clearance", "secret clearance", "five eyes", "nv1 clearance"],
  },
  presencial: {
    label: "100% presencial",
    terms: [
      "100% presencial",
      "modelo presencial",
      "modelo de trabalho: presencial",
      "trabalho 100% presencial",
      "fully on-site",
      "100% on-site",
      "on-site only",
      "trabajo presencial",
    ],
  },
} as const;

export type BlockPreset = keyof typeof BLOCK_PRESETS;
export const BLOCK_PRESET_IDS = Object.keys(BLOCK_PRESETS) as BlockPreset[];

type BlockProfile = Pick<Profile, "block_presets" | "block_terms" | "block_max_years">;

/**
 * Motivos para esconder a vaga (lista vazia = não bloqueada).
 * Cada motivo diz o que foi encontrado, para o usuário entender e ajustar o filtro.
 */
export function blockReasons(profile: BlockProfile, job: { title: string; description: string }): string[] {
  const text = normalize(`${job.title}\n${job.description}`);
  const reasons: string[] = [];

  for (const id of splitList(profile.block_presets)) {
    const preset = BLOCK_PRESETS[id as BlockPreset];
    if (!preset) continue;
    const hit = preset.terms.find((t) => text.includes(normalize(t)));
    if (hit) reasons.push(`${preset.label}: “${hit}”`);
  }

  for (const term of splitList(profile.block_terms)) {
    if (text.includes(normalize(term))) reasons.push(`Contém “${term}”`);
  }

  if (profile.block_max_years > 0) {
    const years = requiredYears(job.description);
    if (years !== null && years >= profile.block_max_years) {
      reasons.push(`Pede ${years}+ anos de experiência (seu limite: menos de ${profile.block_max_years})`);
    }
  }
  return reasons;
}

/** Condição SQL: só vagas não bloqueadas. Usada em toda lista, contagem e na análise automática. */
export const NOT_BLOCKED_SQL = "COALESCE(j.blocked, 0) = 0";
