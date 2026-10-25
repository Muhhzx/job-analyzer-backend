import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  clearLoginFailures,
  endSession,
  hashPassword,
  loginBlockedFor,
  registerLoginFailure,
  requireAuth,
  startSession,
  userFromRequest,
  verifyPassword,
} from "../auth.js";
import { db } from "../db.js";

const RegisterBody = z.object({
  name: z.string().trim().min(1, "Informe seu nome."),
  email: z.string().trim().toLowerCase().email("E-mail inválido."),
  password: z.string().min(8, "A senha precisa de pelo menos 8 caracteres."),
});

const LoginBody = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string(),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/register", async (request, reply) => {
    const body = RegisterBody.parse(request.body);
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(body.email)) {
      return reply.code(409).send({ error: "Esse e-mail já está cadastrado." });
    }
    const r = db
      .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
      .run(body.name, body.email, hashPassword(body.password));
    const id = Number(r.lastInsertRowid);
    startSession(reply, id);
    return { user: { id, name: body.name, email: body.email } };
  });

  app.post("/login", async (request, reply) => {
    const body = LoginBody.parse(request.body);
    const blockedMinutes = loginBlockedFor(body.email);
    if (blockedMinutes > 0) {
      return reply
        .code(429)
        .send({ error: `Muitas tentativas de login. Tente de novo em ${blockedMinutes} min.` });
    }
    const user = db.prepare("SELECT id, name, email, password_hash FROM users WHERE email = ?").get(body.email) as
      | { id: number; name: string; email: string; password_hash: string }
      | undefined;
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      registerLoginFailure(body.email);
      return reply.code(401).send({ error: "E-mail ou senha incorretos." });
    }
    clearLoginFailures(body.email);
    startSession(reply, user.id);
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
