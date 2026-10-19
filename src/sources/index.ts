import { db } from "../db.js";
import type { Profile } from "../profile.js";
import { greenhouse } from "./greenhouse.js";
import { lever } from "./lever.js";
import { remotive } from "./remotive.js";
import type { JobSource, RawJob } from "./types.js";

/** Registro central de fontes. Nova fonte = novo arquivo + uma linha aqui. */
export const SOURCES: JobSource[] = [remotive, greenhouse, lever];

export type CollectResult = { source: string; found: number; added: number; error?: string };

export async function collectJobs(userId: number, profile: Profile): Promise<CollectResult[]> {
  const configured = SOURCES.filter((s) => s.isConfigured(profile));
  return Promise.all(
    configured.map(async (source) => {
      try {
        const jobs = await source.fetchJobs(profile);
        return { source: source.name, found: jobs.length, added: insertJobs(userId, source.id, jobs) };
      } catch (err) {
        return { source: source.name, found: 0, added: 0, error: (err as Error).message };
      }
    }),
  );
}

export function insertJobs(userId: number, sourceId: string, jobs: RawJob[]): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO jobs (user_id, source, external_id, title, company, location, url, description, posted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  for (const j of jobs) {
    const r = stmt.run(userId, sourceId, j.externalId, j.title, j.company, j.location, j.url, j.description, j.postedAt ?? null);
    added += Number(r.changes);
  }
  return added;
}
