import { splitList } from "../profile.js";
import { eachSafely, fetchJson, htmlToText, matchesKeywords, type JobSource } from "./types.js";

type RemotiveResponse = {
  jobs: {
    id: number;
    url: string;
    title: string;
    company_name: string;
    candidate_required_location: string;
    description: string;
    publication_date: string;
  }[];
};

// Até quantas palavras-chave buscamos (uma requisição por palavra).
const MAX_KEYWORDS = 5;

// API pública de vagas remotas: https://remotive.com/api/remote-jobs
export const remotive: JobSource = {
  id: "remotive",
  name: "Remotive",
  description: "Vagas remotas do mundo todo, buscadas pelas suas palavras-chave.",
  profileField: "search_keywords",
  isConfigured: (p) => splitList(p.search_keywords).length > 0,
  async fetchJobs(profile) {
    const keywords = splitList(profile.search_keywords);
    const result = await eachSafely(
      keywords.slice(0, MAX_KEYWORDS),
      async (keyword) => {
        const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(keyword)}&limit=15`;
        const data = await fetchJson<RemotiveResponse>(url);
        return (
          data.jobs
            // A busca do Remotive é ampla demais; garante que a palavra aparece de fato.
            .filter((j) => matchesKeywords(`${j.title} ${j.description}`, [keyword]))
            .map((j) => ({
              externalId: String(j.id),
              title: j.title,
              company: j.company_name,
              location: j.candidate_required_location || "Remoto",
              url: j.url,
              description: htmlToText(j.description),
              postedAt: j.publication_date,
            }))
        );
      },
      (keyword, err) => `busca por "${keyword}": ${err.message}`,
    );
    if (keywords.length > MAX_KEYWORDS) {
      result.warnings.push(
        `só as ${MAX_KEYWORDS} primeiras palavras-chave são usadas aqui (${keywords.slice(MAX_KEYWORDS).join(", ")} ficaram de fora)`,
      );
    }
    return result;
  },
};
