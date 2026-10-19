import { splitList } from "../profile.js";
import { decodeEntities, fetchJson, htmlToText, matchesKeywords, type JobSource, type RawJob } from "./types.js";

type GreenhouseResponse = {
  jobs: {
    id: number;
    title: string;
    absolute_url: string;
    location?: { name?: string };
    content?: string;
    updated_at?: string;
  }[];
};

// Página de carreiras pública de cada empresa: boards.greenhouse.io/<board>
export const greenhouse: JobSource = {
  id: "greenhouse",
  name: "Greenhouse",
  description: "Vagas direto do site de carreiras de empresas que usam Greenhouse (ex.: nubank, gitlab).",
  profileField: "greenhouse_boards",
  isConfigured: (p) => splitList(p.greenhouse_boards).length > 0,
  async fetchJobs(profile) {
    const jobs: RawJob[] = [];
    const keywords = [...splitList(profile.search_keywords), ...splitList(profile.desired_roles)];
    for (const board of splitList(profile.greenhouse_boards).slice(0, 10)) {
      const slug = board.toLowerCase().replace(/[^a-z0-9-]/g, "");
      const data = await fetchJson<GreenhouseResponse>(
        `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
      );
      for (const j of data.jobs) {
        if (!matchesKeywords(j.title, keywords)) continue;
        jobs.push({
          externalId: `${slug}-${j.id}`,
          title: j.title,
          company: slug,
          location: j.location?.name ?? "",
          url: j.absolute_url,
          description: htmlToText(decodeEntities(j.content ?? "")),
          postedAt: j.updated_at,
        });
      }
    }
    return jobs.slice(0, 40);
  },
};
