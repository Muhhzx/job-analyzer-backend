import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  endSession,
  hashPassword,
  loginFailuresByEmail,
  loginFailuresByIp,
  registrationsByIp,
  requireAuth,
  startSession,
  userFromRequest,
  verifyPassword,
} from "../auth.js";
import { db } from "../db.js";

const RegisterBody = z.object({
  name: z.string().trim().min(1, "Informe seu nome.").max(100, "Nome muito longo."),
  email: z.string().trim().toLowerCase().max(254, "E-mail muito longo.").email("E-mail inválido."),
  // Limite de tamanho: senhas enormes deixariam o scrypt lento de propósito.
  password: z
    .string()
    .min(8, "A senha precisa de pelo menos 8 caracteres.")
    .max(128, "A senha pode ter no máximo 128 caracteres."),
});

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().max(128),
});

const tooMany = (minutes: number) => ({ error: `Muitas tentativas. Tente de novo em ${minutes} min.` });

export async function authRoutes(app: FastifyInstance) {
  app.post("/register", async (request, reply) => {
    const blocked = registrationsByIp.blockedFor(request.ip);
    if (blocked > 0) return reply.code(429).send(tooMany(blocked));
    registrationsByIp.hit(request.ip);
    const body = RegisterBody.parse(request.body);
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(body.email)) {
      return reply.code(409).send({ error: "Esse e-mail já está cadastrado." });
    }
    const r = db
      .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
      .run(body.name, body.email, hashPassword(body.password));
    const id = Number(r.lastInsertRowid);
    startSession(request, reply, id);
    return { user: { id, name: body.name, email: body.email } };
  });

  app.post("/login", async (request, reply) => {
    const body = LoginBody.parse(request.body);
    const blocked = Math.max(loginFailuresByEmail.blockedFor(body.email), loginFailuresByIp.blockedFor(request.ip));
    if (blocked > 0) return reply.code(429).send(tooMany(blocked));
    const user = db.prepare("SELECT id, name, email, password_hash FROM users WHERE email = ?").get(body.email) as
      | { id: number; name: string; email: string; password_hash: string }
      | undefined;
    // Sem conta, a senha é conferida contra um hash falso: mesmo tempo de resposta e mesma mensagem.
    if (!verifyPassword(body.password, user?.password_hash) || !user) {
      loginFailuresByEmail.hit(body.email);
      loginFailuresByIp.hit(request.ip);
      return reply.code(401).send({ error: "E-mail ou senha incorretos." });
    }
    loginFailuresByEmail.clear(body.email);
    startSession(request, reply, user.id);
    return { user: { id: user.id, name: user.name, email: user.email } };
  });

  app.post("/logout", async (request, reply) => {
    endSession(request, reply);
    return { ok: true };
  });

  app.get("/me", async (request, reply) => {
    const user = userFromRequest(request);
    if (!user) return reply.code(401).send({ error: "Não autenticado." });
    return { user };
  });

  app.delete("/me", { preHandler: requireAuth }, async (request, reply) => {
    endSession(request, reply);
    db.prepare("DELETE FROM users WHERE id = ?").run(request.user.id);
    return { ok: true };
  });
}
