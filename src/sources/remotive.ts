import { splitList } from "../profile.js";
import { fetchJson, htmlToText, matchesKeywords, type JobSource, type RawJob } from "./types.js";

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

// API pública de vagas remotas: https://remotive.com/api/remote-jobs
export const remotive: JobSource = {
  id: "remotive",
  name: "Remotive",
  description: "Vagas remotas do mundo todo, buscadas pelas suas palavras-chave.",
  profileField: "search_keywords",
  isConfigured: (p) => splitList(p.search_keywords).length > 0,
  async fetchJobs(profile) {
    const jobs: RawJob[] = [];
    for (const keyword of splitList(profile.search_keywords).slice(0, 5)) {
      const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(keyword)}&limit=15`;
      const data = await fetchJson<RemotiveResponse>(url);
      for (const j of data.jobs) {
        // A busca do Remotive é ampla demais; garante que a palavra aparece de fato.
        if (!matchesKeywords(`${j.title} ${j.description}`, [keyword])) continue;
        jobs.push({
          externalId: String(j.id),
          title: j.title,
          company: j.company_name,
          location: j.candidate_required_location || "Remoto",
          url: j.url,
          description: htmlToText(j.description),
          postedAt: j.publication_date,
        });
      }
    }
    return jobs;
  },
};
