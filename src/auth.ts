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

/**
 * Hash de uma senha que não existe, usado quando o e-mail não está cadastrado.
 * Assim o login demora o mesmo com ou sem conta, e o tempo de resposta não revela
 * quais e-mails existem.
 */
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString("hex"));

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (stored === undefined) {
    verifyPassword(password, DUMMY_HASH);
    return false;
  }
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

/**
 * O banco guarda só o SHA-256 do token, nunca o token em si.
 * Se alguém copiar o arquivo do banco, não consegue usar as sessões para entrar.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Cria uma sessão nova (token aleatório de 256 bits) e envia no cookie.
 * Se a requisição já tinha uma sessão, ela é apagada: cada login gera um token novo.
 */
export function startSession(request: FastifyRequest, reply: FastifyReply, userId: number) {
  const previous = request.cookies[SESSION_COOKIE];
  if (previous) db.prepare("DELETE FROM sessions WHERE token = ?").run(hashToken(previous));

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    hashToken(token),
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
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(hashToken(token));
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function userFromRequest(request: FastifyRequest): User | null {
  const token = request.cookies[SESSION_COOKIE];
  // Token com formato errado nem consulta o banco.
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    )
    .get(hashToken(token)) as (User & { expires_at: string }) | undefined;
  if (!row || new Date(row.expires_at) < new Date()) return null;
  return { id: row.id, name: row.name, email: row.email };
}

/** Apaga as sessões vencidas (roda na inicialização e de hora em hora). */
export function cleanupExpiredSessions(): number {
  const r = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  return Number(r.changes);
}

/**
 * Limites de tentativas, em janelas de 15 minutos. Protegem contra robôs testando senhas:
 * - por e-mail: 5 senhas erradas bloqueiam aquele e-mail;
 * - por IP: 20 senhas erradas (em qualquer e-mail) ou REGISTER_LIMIT_PER_IP cadastros (padrão 10) bloqueiam aquele IP.
 * Ficam em memória: valem para um servidor só e zeram se ele reiniciar (veja o README).
 */
const WINDOW_MS = 15 * 60 * 1000;

class AttemptLimiter {
  private entries = new Map<string, { count: number; since: number }>();
  constructor(private max: number) {}

  /** Minutos que faltam para liberar (0 = liberado). */
  blockedFor(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    const elapsed = Date.now() - entry.since;
    if (elapsed > WINDOW_MS) {
      this.entries.delete(key);
      return 0;
    }
    return entry.count >= this.max ? Math.ceil((WINDOW_MS - elapsed) / 60000) : 0;
  }

  hit(key: string) {
    const entry = this.entries.get(key);
    if (!entry || Date.now() - entry.since > WINDOW_MS) this.entries.set(key, { count: 1, since: Date.now() });
    else entry.count++;
    // Não deixa o mapa crescer sem fim com chaves velhas.
    if (this.entries.size > 10_000) {
      for (const [k, v] of this.entries) if (Date.now() - v.since > WINDOW_MS) this.entries.delete(k);
    }
  }

  clear(key: string) {
    this.entries.delete(key);
  }

  reset() {
    this.entries.clear();
  }
}

export const loginFailuresByEmail = new AttemptLimiter(5);
export const loginFailuresByIp = new AttemptLimiter(20);
export const registrationsByIp = new AttemptLimiter(config.registerLimitPerIp);

/** Zera todos os limites (usado nos testes). */
export function resetRateLimits() {
  loginFailuresByEmail.reset();
  loginFailuresByIp.reset();
  registrationsByIp.reset();
}

/** preHandler para rotas que exigem login. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const user = userFromRequest(request);
  if (!user) return reply.code(401).send({ error: "Faça login para continuar." });
  request.user = user;
}
