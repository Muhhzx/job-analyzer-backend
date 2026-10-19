import type { Profile } from "../profile.js";

export type RawJob = {
  externalId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  postedAt?: string;
};

/**
 * Uma fonte de vagas. Para adicionar uma nova fonte (Gupy, Adzuna, e-mails de
 * alerta do LinkedIn...), crie um arquivo que exporte um JobSource e registre
 * em ./index.ts.
 */
export type JobSource = {
  id: string;
  name: string;
  description: string;
  /** Campo do perfil que configura essa fonte. */
  profileField: "search_keywords" | "greenhouse_boards" | "lever_boards";
  isConfigured(profile: Profile): boolean;
  fetchJobs(profile: Profile): Promise<RawJob[]>;
};

export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": "JobAnalyzer/0.2", Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} respondeu ${res.status}`);
  return (await res.json()) as T;
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Sem palavras-chave, tudo passa; com elas, o texto precisa conter alguma. */
export function matchesKeywords(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const t = normalize(text);
  return keywords.some((k) => t.includes(normalize(k)));
}
