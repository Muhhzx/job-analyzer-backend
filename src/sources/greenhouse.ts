import { splitList } from "../profile.js";
import { boardError, decodeEntities, eachSafely, fetchJson, htmlToText, matchesKeywords, type JobSource } from "./types.js";

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
  description: "Vagas direto do site de carreiras de empresas que usam Greenhouse (ex.: stone, c6bank).",
  profileField: "greenhouse_boards",
  isConfigured: (p) => splitList(p.greenhouse_boards).length > 0,
  async fetchJobs(profile) {
    const keywords = [...splitList(profile.search_keywords), ...splitList(profile.desired_roles)];
    const boards = splitList(profile.greenhouse_boards).slice(0, 20);

    const result = await eachSafely(
      boards,
      async (board) => {
        const slug = board.toLowerCase().replace(/[^a-z0-9-]/g, "");
        const data = await fetchJson<GreenhouseResponse>(
          `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
        );
        return data.jobs
          .filter((j) => matchesKeywords(j.title, keywords))
          .map((j) => ({
            externalId: `${slug}-${j.id}`,
            title: j.title,
            company: slug,
            location: j.location?.name ?? "",
            url: j.absolute_url,
            description: htmlToText(decodeEntities(j.content ?? "")),
            postedAt: j.updated_at,
          }));
      },
      (board, err) => boardError("Greenhouse", board, err),
    );
    return result;
  },
};
