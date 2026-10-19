import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { db } from "./db.js";

export const SESSION_COOKIE = "ja_session";
const SESSION_DAYS = 30;

export type User = { id: number; name: string; email: string };

declare module "fastify" {
  interface FastifyRequest {
    user: User;
  }
}

// Senhas com scrypt + salt aleatório. Formato salvo: "salt:hash" (hex).
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

export function startSession(reply: FastifyReply, userId: number) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    expires.toISOString(),
  );
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.production,
    path: "/",
    expires,
  });
}

export function endSession(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[SESSION_COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function userFromRequest(request: FastifyRequest): User | null {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    )
    .get(token) as (User & { expires_at: string }) | undefined;
  if (!row || new Date(row.expires_at) < new Date()) return null;
  return { id: row.id, name: row.name, email: row.email };
}

/** preHandler para rotas que exigem login. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const user = userFromRequest(request);
  if (!user) return reply.code(401).send({ error: "Faça login para continuar." });
  request.user = user;
}
