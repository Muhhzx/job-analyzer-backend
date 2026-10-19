import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import {
  AUTO_COLLECT_OPTIONS,
  getProfile,
  profileCompletion,
  updateProfile,
  WORK_MODES,
} from "../profile.js";

const text = z.string().max(20_000).optional();

const ProfileBody = z.object({
  headline: text,
  seniority: text,
  desired_roles: text,
  skills: text,
  experience: text,
  languages: text,
  locations: text,
  work_mode: z.enum(WORK_MODES as [string, ...string[]]).optional(),
  salary_min: text,
  deal_breakers: text,
  resume_text: z.string().max(60_000).optional(),
  search_keywords: text,
  greenhouse_boards: text,
  lever_boards: text,
  min_score: z.number().int().min(0).max(100).optional(),
  auto_collect_hours: z
    .number()
    .int()
    .refine((h) => AUTO_COLLECT_OPTIONS.includes(h), "Intervalo inválido.")
    .optional(),
  auto_analyze: z.boolean().optional(),
});

function serialize(userId: number) {
  const profile = getProfile(userId);
  return {
    profile: { ...profile, auto_analyze: Boolean(profile.auto_analyze) },
    completion: profileCompletion(profile),
  };
}

export async function profileRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.get("/", async (request) => serialize(request.user.id));

  app.put("/", async (request) => {
    const body = ProfileBody.parse(request.body);
    updateProfile(request.user.id, { ...body, auto_analyze: body.auto_analyze === undefined ? undefined : body.auto_analyze ? 1 : 0 });
    return serialize(request.user.id);
  });
}
