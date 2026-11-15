import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken, resetRateLimits, SESSION_COOKIE } from "../src/auth.js";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { type Api, createApi, randomIp, registerUser, sessionCookie } from "./helpers.js";

let app: Api;
beforeAll(async () => {
  app = await createApi();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => resetRateLimits());

const login = (email: string, password: string, ip = randomIp(), cookie?: string) =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
    remoteAddress: ip,
    headers: cookie ? { cookie } : {},
  });

const me = (cookie?: string) =>
  app.inject({ method: "GET", url: "/api/auth/me", headers: cookie ? { cookie } : {} });

describe("ambiente de teste", () => {
  it("usa um banco temporário e a IA desligada (nenhum teste gasta cota)", () => {
    expect(config.dbPath).not.toMatch(/data[\\/]job-analyzer\.db$/);
    expect(config.ai.enabled).toBe(false);
  });
});

describe("cadastro", () => {
  it("cria a conta e já entra", async () => {
    const { cookie, email } = await registerUser(app);
    const res = await me(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(email);
  });

  it("guarda a senha só como hash scrypt com salt", async () => {
    const { email, password } = await registerUser(app);
    const row = db.prepare("SELECT password_hash FROM users WHERE email = ?").get(email) as { password_hash: string };
    expect(row.password_hash).not.toContain(password);
    expect(row.password_hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  it("recusa e-mail repetido, inválido, senha curta e senha gigante", async () => {
    const { email } = await registerUser(app);
    const post = (payload: object) =>
      app.inject({ method: "POST", url: "/api/auth/register", payload, remoteAddress: randomIp() });

    expect((await post({ name: "X", email, password: "senha-forte-123" })).statusCode).toBe(409);
    expect((await post({ name: "X", email: "nao-e-email", password: "senha-forte-123" })).statusCode).toBe(400);
    expect((await post({ name: "X", email: "a@b.com", password: "curta" })).statusCode).toBe(400);
    expect((await post({ name: "X", email: "c@d.com", password: "x".repeat(129) })).statusCode).toBe(400);
  });

  it("limita cadastros em massa vindos do mesmo IP", async () => {
    const ip = randomIp();
    for (let i = 0; i < 10; i++) await registerUser(app, { ip });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "X", email: "spam@teste.local", password: "senha-forte-123" },
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(429);
  });
});

describe("login", () => {
  it("entra com a senha certa e o e-mail em qualquer caixa", async () => {
    const { email, password } = await registerUser(app);
    const res = await login(email.toUpperCase(), password);
    expect(res.statusCode).toBe(200);
    expect((await me(sessionCookie(res))).statusCode).toBe(200);
  });

  it("dá a mesma resposta para senha errada e para e-mail que não existe", async () => {
    const { email } = await registerUser(app);
    const wrong = await login(email, "senha-errada-123");
    const missing = await login("ninguem@teste.local", "senha-errada-123");
    expect(wrong.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(wrong.json()).toEqual(missing.json());
    expect(wrong.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  it("bloqueia o e-mail depois de 5 senhas erradas, mesmo com a senha certa", async () => {
    const { email, password } = await registerUser(app);
    for (let i = 0; i < 5; i++) expect((await login(email, "errada-errada")).statusCode).toBe(401);
    expect((await login(email, password)).statusCode).toBe(429);
  });

  it("bloqueia o IP que testa senhas em muitos e-mails diferentes", async () => {
    const ip = randomIp();
    for (let i = 0; i < 20; i++) await login(`alvo${i}@teste.local`, "errada-errada", ip);
    const { email, password } = await registerUser(app);
    expect((await login(email, password, ip)).statusCode).toBe(429);
    expect((await login(email, password)).statusCode).toBe(200); // outro IP continua entrando
  });

  it("envia o cookie com httpOnly, SameSite=Lax e path /", async () => {
    const { email, password } = await registerUser(app);
    const c = (await login(email, password)).cookies.find((x) => x.name === SESSION_COOKIE)!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("Lax");
    expect(c.path).toBe("/");
    expect(c.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it("guarda no banco só o hash do token, nunca o token", async () => {
    const { cookie } = await registerUser(app);
    const token = cookie.split("=")[1]!;
    expect(db.prepare("SELECT 1 FROM sessions WHERE token = ?").get(token)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sessions WHERE token = ?").get(hashToken(token))).toBeDefined();
  });

  it("um novo login no mesmo navegador invalida o token antigo", async () => {
    const { email, password, cookie } = await registerUser(app);
    const res = await login(email, password, randomIp(), cookie);
    expect((await me(cookie)).statusCode).toBe(401);
    expect((await me(sessionCookie(res))).statusCode).toBe(200);
  });
});

describe("sessão", () => {
  it("recusa sem cookie, com token inventado ou com formato estranho", async () => {
    expect((await me()).statusCode).toBe(401);
    expect((await me(`${SESSION_COOKIE}=${"a".repeat(64)}`)).statusCode).toBe(401);
    expect((await me(`${SESSION_COOKIE}=' OR 1=1 --`)).statusCode).toBe(401);
  });

  it("não aceita o hash guardado no banco como se fosse o token", async () => {
    const { cookie } = await registerUser(app);
    const stored = hashToken(cookie.split("=")[1]!);
    expect((await me(`${SESSION_COOKIE}=${stored}`)).statusCode).toBe(401);
  });

  it("logout apaga a sessão: o mesmo cookie não serve mais", async () => {
    const { cookie } = await registerUser(app);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it("sessão vencida não entra", async () => {
    const { cookie } = await registerUser(app);
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      hashToken(cookie.split("=")[1]!),
    );
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it("toda rota privada responde 401 sem login", async () => {
    const routes: [string, string][] = [
      ["GET", "/api/jobs"],
      ["GET", "/api/jobs/1"],
      ["POST", "/api/jobs"],
      ["PATCH", "/api/jobs/1"],
      ["DELETE", "/api/jobs/1"],
      ["POST", "/api/jobs/1/analyze"],
      ["POST", "/api/jobs/collect"],
      ["GET", "/api/applications"],
      ["PATCH", "/api/applications/1"],
      ["DELETE", "/api/applications/1"],
      ["GET", "/api/profile"],
      ["PUT", "/api/profile"],
      ["GET", "/api/dashboard"],
      ["GET", "/api/sources"],
      ["GET", "/api/notifications"],
      ["POST", "/api/notifications/read"],
      ["DELETE", "/api/auth/me"],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as "GET", url, payload: method === "GET" ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("respostas da API não ficam em cache", async () => {
    const { cookie } = await registerUser(app);
    const res = await me(cookie);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("excluir a conta apaga usuário, sessões e vagas", async () => {
    const { cookie, id } = await registerUser(app);
    await app.inject({
      method: "POST",
      url: "/api/jobs",
      headers: { cookie },
      payload: { title: "Vaga", description: "x".repeat(60) },
    });
    const res = await app.inject({ method: "DELETE", url: "/api/auth/me", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sessions WHERE user_id = ?").get(id)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM jobs WHERE user_id = ?").get(id)).toBeUndefined();
  });
});
