import { splitList } from "../profile.js";
import { detectJobLevel } from "../seniority.js";
import { eachSafely, fetchJson, matchesKeywords, type JobSource, type RawJob } from "./types.js";

type GitHubIssue = {
  id: number;
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  created_at: string;
  labels: { name: string }[];
  pull_request?: unknown;
};

const REPOS = ["backend-br/vagas", "frontendbr/vagas"];

const WORKPLACE_LABELS = ["Remoto", "Híbrido", "Presencial"];
const LEVEL_LABELS = ["Estágio", "Júnior", "Pleno", "Sênior", "Especialista"];

async function fetchRepo(repo: string): Promise<GitHubIssue[]> {
  const url = `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`;
  const issues = await fetchJson<GitHubIssue[]>(url);
  return issues.filter((issue) => !issue.pull_request);
}


function extractCompany(title: string): string {
  const position = title.lastIndexOf(" - ");
  if (position !== -1) return title.slice(position + 3).trim();
  const afterNa = title.match(/\s(?:na|no|at|@)\s+([^()[\]]+)$/i);
  return afterNa ? afterNa[1]!.trim() : "";
}

/** "[Buenos Aires, Argentina] Cloud Engineer" → "Buenos Aires, Argentina" (o texto entre colchetes no início). */
function extractBracketLocation(title: string): string {
  return title.match(/^\s*\[([^\]]+)\]/)?.[1]?.trim() ?? "";
}

function toRawJob(repo: string, issue: GitHubIssue): RawJob {
  const labels = issue.labels.map((label) => label.name);
  const workplace = labels.find((label) => WORKPLACE_LABELS.includes(label)) ?? "";
  const level = labels.find((label) => LEVEL_LABELS.includes(label));

  // Se o título não diz o nível mas a etiqueta diz, coloca no título para a detecção de senioridade.
  const title =
    level && detectJobLevel(issue.title).level === null ? `${issue.title} (${level})` : issue.title;

  return {
    externalId: `${repo}#${issue.number}`,
    title,
    company: extractCompany(issue.title),
    // Etiqueta de local; sem ela, o que estiver entre colchetes no começo do título.
    location: workplace || extractBracketLocation(issue.title),
    url: issue.html_url,
    // As etiquetas entram no texto para a prévia grátis achar as suas habilidades nelas.
    description: `${issue.body ?? ""}\n\nEtiquetas: ${labels.join(", ")}`,
    postedAt: issue.created_at,
  };
}

export const github: JobSource = {
  id: "github",
  name: "GitHub (comunidade)",
  description: "Vagas de tecnologia publicadas pela comunidade brasileira (backend-br, frontendbr).",
  profileField: "search_keywords",
  isConfigured: (profile) => splitList(profile.search_keywords).length > 0,

  async fetchJobs(profile) {
    const keywords = splitList(profile.search_keywords);
    return eachSafely(
      REPOS,
      async (repo) => {
        const issues = await fetchRepo(repo);
        return issues
          .map((issue) => toRawJob(repo, issue))
          .filter((job) => matchesKeywords(`${job.title} ${job.description}`, keywords));
      },
      (repo, err) => `repositório ${repo}: ${err.message}`,
    );
  },
};