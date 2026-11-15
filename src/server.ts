import { buildApp } from "./app.js";
import { cleanupExpiredSessions } from "./auth.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { refreshPendingPreviewsForAllUsers } from "./preview.js";
import { startScheduler } from "./scheduler.js";

const app = await buildApp();

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
