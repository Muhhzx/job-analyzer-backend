import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { ZodError } from "zod";
import { config } from "./config.js";
import { applicationRoutes } from "./routes/applications.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { jobRoutes } from "./routes/jobs.js";
import { profileRoutes } from "./routes/profile.js";

/**
 * Monta a API (rotas, cookie, erros e cabeçalhos de segurança) sem abrir porta.
 * O server.ts chama e faz o listen; os testes chamam e usam `app.inject`.
 */
export async function buildApp({ logger = true }: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: logger ? { level: config.production ? "info" : "warn" } : false,
    // A API só escuta em 127.0.0.1 e recebe tudo pelo proxy do Next. Confiar no
    // X-Forwarded-For vindo daí faz `request.ip` ser o IP real do usuário (usado nos limites de login).
    trustProxy: ["127.0.0.1", "::1"],
  });

  await app.register(cookie);

  // Respostas com dados pessoais: nada de cache em navegador ou proxy, e o navegador
  // não deve adivinhar o tipo do conteúdo.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
  });

  // Erros de validação viram 400 com a primeira mensagem legível.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: error.issues[0]?.message ?? "Dados inválidos." });
    }
    app.log.error(error);
    const { statusCode = 500, message } = error as { statusCode?: number; message?: string };
    return reply.code(statusCode).send({ error: statusCode === 500 ? "Erro interno no servidor." : message });
  });

  app.get("/api/health", async () => ({ ok: true }));
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(profileRoutes, { prefix: "/api/profile" });
  await app.register(jobRoutes, { prefix: "/api/jobs" });
  await app.register(applicationRoutes, { prefix: "/api/applications" });
  await app.register(dashboardRoutes, { prefix: "/api" });

  return app;
}
