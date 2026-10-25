import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { ZodError } from "zod";
import { cleanupExpiredSessions } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { refreshPendingPreviewsForAllUsers } from "./preview.js";
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

// Manutenção na inicialização: prévias pendentes (ex.: após migração) e sessões vencidas.
// Assim as rotas de leitura só leem, sem trabalho extra a cada requisição.
const pending = refreshPendingPreviewsForAllUsers();
const expired = cleanupExpiredSessions();
setInterval(cleanupExpiredSessions, 60 * 60 * 1000).unref();

startScheduler();

// Desligamento limpo (Ctrl+C ou o serviço do Windows parando): fecha conexões e o banco.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: "127.0.0.1" });
console.log(`API rodando em http://localhost:${config.port}`);
if (pending || expired) console.log(`Manutenção: ${pending} prévias calculadas, ${expired} sessões vencidas removidas`);
console.log(`IA: ${config.ai.enabled ? config.ai.model : "desligada (sem ANTHROPIC_API_KEY)"}`);
