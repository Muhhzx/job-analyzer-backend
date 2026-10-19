import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { ZodError } from "zod";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { jobRoutes } from "./routes/jobs.js";
import { profileRoutes } from "./routes/profile.js";
import { startScheduler } from "./scheduler.js";

const app = Fastify({ logger: { level: config.production ? "info" : "warn" } });

await app.register(cookie);

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
await app.register(dashboardRoutes, { prefix: "/api" });

startScheduler();

await app.listen({ port: config.port, host: "127.0.0.1" });
console.log(`API rodando em http://localhost:${config.port}`);
console.log(`IA: ${config.ai.enabled ? config.ai.model : "desligada (sem ANTHROPIC_API_KEY)"}`);
