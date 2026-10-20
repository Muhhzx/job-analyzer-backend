import { splitList } from "../profile.js";
import { eachSafely, fetchJson, htmlToText, matchesKeywords, type JobSource, type RawJob } from "./types.js";

/**
 * Gupy: a maior plataforma de vagas de empresas brasileiras.
 * Usamos o mesmo endereço que o site portal.gupy.io usa para buscar vagas.
 * Não é uma API oficial documentada: pode mudar sem aviso.
 *
 * Estrutura igual à das outras fontes (veja remotive.ts): buscar → traduzir (toRawJob).
 */

// Formato de cada vaga que a Gupy devolve (só os campos que usamos).
type GupyJob = {
  id: number;
  name: string; // título da vaga
  careerPageName: string; // nome da empresa
  city: string; // pode vir vazio ""
  state: string; // pode vir vazio ""
  workplaceType: "remote" | "hybrid" | "on-site" | string;
  description: string; // texto com HTML (ex.: &nbsp;)
  jobUrl: string;
  publishedDate: string;
};

type GupyResponse = { data: GupyJob[] };

// Uma busca por palavra-chave; até quantas palavras usamos e quantas vagas por palavra.
const MAX_KEYWORDS = 5;
const JOBS_PER_KEYWORD = 20;

const WORKPLACE_LABEL: Record<string, string> = {
  remote: "Remoto",
  hybrid: "Híbrido",
  "on-site": "Presencial",
};

/**
 * Junta cidade, estado e modelo de trabalho, pulando o que vier vazio.
 *   "São Paulo", "SP", "hybrid"  →  "São Paulo, SP · Híbrido"
 *   "",          "",   "remote"  →  "Remoto"
 */
function formatLocation(job: GupyJob): string {
  const place = [job.city, job.state].filter(Boolean).join(", ");
  const mode = WORKPLACE_LABEL[job.workplaceType] ?? "";
  return [place, mode].filter(Boolean).join(" · ");
}

/** Traduz uma vaga da Gupy para o formato do sistema (RawJob). */
function toRawJob(job: GupyJob): RawJob {
  return {
    externalId: String(job.id), // o id da Gupy é número; no banco guardamos texto
    title: job.name,
    company: job.careerPageName,
    location: formatLocation(job),
    url: job.jobUrl,
    description: htmlToText(job.description ?? ""), // vem com HTML (&nbsp;, <p>...)
    postedAt: job.publishedDate,
  };
}

export const gupy: JobSource = {
  id: "gupy",
  name: "Gupy",
  description: "Vagas de empresas brasileiras na Gupy, buscadas pelas suas palavras-chave.",
  profileField: "search_keywords",
  isConfigured: (p) => splitList(p.search_keywords).length > 0,

  async fetchJobs(profile) {
    const keywords = splitList(profile.search_keywords).slice(0, MAX_KEYWORDS);

    // eachSafely: busca uma palavra-chave por vez; se uma falhar, as outras continuam.
    return eachSafely(
      keywords,
      async (keyword) => {
        // encodeURIComponent: transforma "front end" em "front%20end", seguro para URL.
        const url = `https://portal.gupy.io/api/job-search/jobs?jobName=${encodeURIComponent(keyword)}&limit=${JOBS_PER_KEYWORD}&offset=0`;

        const response = await fetchJson<GupyResponse>(url);
        return (
          response.data
            // A busca da Gupy aproxima palavras ("Angular" traz vagas de "Ângulo/PR").
            // Mantém só as vagas em que a palavra-chave aparece de verdade.
            .filter((j) => matchesKeywords(`${j.name} ${j.description ?? ""}`, [keyword]))
            .map(toRawJob)
        );
      },
      (keyword, err) => `busca por "${keyword}": ${err.message}`,
    );
  },
};
