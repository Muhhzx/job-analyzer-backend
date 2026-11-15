import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { SESSION_COOKIE } from "../src/auth.js";

export type Api = FastifyInstance;

export async function createApi(): Promise<Api> {
  const app = await buildApp({ logger: false });
  await app.ready();
  return app;
}

/** Cria um usuário com e-mail único e devolve o cookie de sessão dele. */
export async function registerUser(app: Api, overrides: { email?: string; password?: string; ip?: string } = {}) {
  const email = overrides.email ?? `user-${crypto.randomUUID()}@teste.local`;
  const password = overrides.password ?? "senha-forte-123";
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { name: "Pessoa Teste", email, password },
    remoteAddress: overrides.ip ?? randomIp(),
  });
  if (res.statusCode !== 200) throw new Error(`register falhou: ${res.statusCode} ${res.body}`);
  return { email, password, cookie: sessionCookie(res), id: res.json().user.id as number };
}

export function sessionCookie(res: { cookies: { name: string; value: string }[] }) {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  if (!c) throw new Error("resposta sem cookie de sessão");
  return `${SESSION_COOKIE}=${c.value}`;
}

/** IP diferente por chamada, para os limites por IP não interferirem entre testes. */
export function randomIp() {
  return `10.${rand()}.${rand()}.${rand()}`;
}
const rand = () => Math.floor(Math.random() * 250) + 1;

const DESCRIPTION =
  "Desenvolvedor Angular e .NET para projeto com APIs REST, testes automatizados, CI/CD e SQL Server. ".repeat(2);

/** Cola uma vaga (rota POST /jobs) e devolve o id. */
export async function createJob(app: Api, cookie: string, title = "Desenvolvedor .NET", company = "Empresa X") {
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs",
    headers: { cookie },
    payload: { title, company, description: DESCRIPTION },
  });
  if (res.statusCode !== 200) throw new Error(`createJob falhou: ${res.statusCode} ${res.body}`);
  return res.json().job.id as number;
}
