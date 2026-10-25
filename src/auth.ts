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

/** Apaga as sessões vencidas (roda na inicialização e de hora em hora). */
export function cleanupExpiredSessions(): number {
  const r = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  return Number(r.changes);
}

/**
 * Limite de tentativas de login por e-mail: 5 erros em 15 minutos bloqueiam esse
 * e-mail por 15 minutos. Protege contra robôs testando senhas. Fica em memória:
 * vale para um servidor só e zera se ele reiniciar (veja o README).
 */
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; since: number }>();

export function loginBlockedFor(email: string): number {
  const entry = failures.get(email);
  if (!entry) return 0;
  const elapsed = Date.now() - entry.since;
  if (elapsed > WINDOW_MS) {
    failures.delete(email);
    return 0;
  }
  return entry.count >= MAX_FAILURES ? Math.ceil((WINDOW_MS - elapsed) / 60000) : 0;
}

export function registerLoginFailure(email: string) {
  const entry = failures.get(email);
  if (!entry || Date.now() - entry.since > WINDOW_MS) failures.set(email, { count: 1, since: Date.now() });
  else entry.count++;
}

export function clearLoginFailures(email: string) {
  failures.delete(email);
}

/** preHandler para rotas que exigem login. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const user = userFromRequest(request);
  if (!user) return reply.code(401).send({ error: "Faça login para continuar." });
  request.user = user;
}
