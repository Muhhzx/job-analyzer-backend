import { splitList } from "../profile.js";
import { fetchJson, htmlToText, matchesKeywords, type JobSource, type RawJob } from "./types.js";

type LeverPosting = {
  id: string;
  text: string;
  hostedUrl: string;
  categories?: { location?: string };
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  createdAt?: number;
};

// Página de carreiras pública de cada empresa: jobs.lever.co/<empresa>
export const lever: JobSource = {
  id: "lever",
  name: "Lever",
  description: "Vagas direto do site de carreiras de empresas que usam Lever.",
  profileField: "lever_boards",
  isConfigured: (p) => splitList(p.lever_boards).length > 0,
  async fetchJobs(profile) {
    const jobs: RawJob[] = [];
    const keywords = [...splitList(profile.search_keywords), ...splitList(profile.desired_roles)];
    for (const board of splitList(profile.lever_boards).slice(0, 10)) {
      const slug = board.toLowerCase().replace(/[^a-z0-9-]/g, "");
      const postings = await fetchJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${slug}?mode=json`);
      for (const j of postings) {
        if (!matchesKeywords(j.text, keywords)) continue;
        const lists = (j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join("\n\n");
        jobs.push({
          externalId: `${slug}-${j.id}`,
          title: j.text,
          company: slug,
          location: j.categories?.location ?? "",
          url: j.hostedUrl,
          description: [j.descriptionPlain ?? "", lists].filter(Boolean).join("\n\n"),
          postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
        });
      }
    }
    return jobs.slice(0, 40);
  },
};
