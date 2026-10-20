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
  fetchJobs(profile: Profile): Promise<FetchResult>;
};

/**
 * O que uma fonte devolve. `warnings` lista o que deu errado (ex.: empresa que não
 * existe) sem derrubar o resto: as vagas das outras empresas continuam vindo.
 */
export type FetchResult = { jobs: RawJob[]; warnings: string[] };

/**
 * Roda `fn` para cada item (empresa ou palavra-chave). Se um falhar, anota o aviso
 * e segue para o próximo, em vez de perder tudo por causa de um nome errado.
 */
export async function eachSafely<T>(
  items: T[],
  fn: (item: T) => Promise<RawJob[]>,
  describeError: (item: T, err: Error) => string,
): Promise<FetchResult> {
  const jobs: RawJob[] = [];
  const warnings: string[] = [];
  for (const item of items) {
    try {
      jobs.push(...(await fn(item)));
    } catch (err) {
      warnings.push(describeError(item, err as Error));
    }
  }
  return { jobs, warnings };
}

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

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Mensagem amigável para uma empresa que falhou no Greenhouse/Lever. */
export function boardError(site: string, board: string, err: Error): string {
  if (err instanceof HttpError && err.status === 404) {
    return `"${board}" não existe no ${site} (confira o nome ou remova da lista)`;
  }
  return `"${board}": ${err.message}`;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": "JobAnalyzer/0.2", Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new HttpError(res.status, `${new URL(url).host} respondeu ${res.status}`);
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
