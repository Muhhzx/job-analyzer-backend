import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notify } from "../src/notify.js";
import { type Api, createApi, createJob, registerUser } from "./helpers.js";

/**
 * Cada pessoa só enxerga e mexe nos próprios dados.
 * Ana cria vaga, candidatura, perfil e notificação; Bruno tenta acessar tudo isso.
 */
let app: Api;
let ana: Awaited<ReturnType<typeof registerUser>>;
let bruno: Awaited<ReturnType<typeof registerUser>>;
let anaJob: number;

beforeAll(async () => {
  app = await createApi();
  ana = await registerUser(app);
  bruno = await registerUser(app);
  anaJob = await createJob(app, ana.cookie, "Vaga secreta da Ana", "Empresa da Ana");
  await app.inject({
    method: "PATCH",
    url: `/api/applications/${anaJob}`,
    headers: { cookie: ana.cookie },
    payload: { stage: "entrevista", notes: "anotação privada", contact: "recrutador@empresa" },
  });
  await app.inject({
    method: "PUT",
    url: "/api/profile",
    headers: { cookie: ana.cookie },
    payload: { headline: "Perfil privado da Ana", resume_text: "currículo da Ana" },
  });
  await notify(ana.id, anaJob, "aviso só da Ana");
});
afterAll(async () => {
  await app.close();
});

const asBruno = (method: string, url: string, payload?: object) =>
  app.inject({ method: method as "GET", url, headers: { cookie: bruno.cookie }, payload });

describe("vagas de outra pessoa", () => {
  it("não aparecem na lista nem na busca", async () => {
    const res = await asBruno("GET", "/api/jobs?filter=todas&q=secreta");
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
    expect(res.body).not.toContain("Ana");
  });

  it("não podem ser lidas, alteradas, excluídas nem analisadas", async () => {
    expect((await asBruno("GET", `/api/jobs/${anaJob}`)).statusCode).toBe(404);
    expect((await asBruno("PATCH", `/api/jobs/${anaJob}`, { status: "descartada" })).statusCode).toBe(404);
    expect((await asBruno("DELETE", `/api/jobs/${anaJob}`)).statusCode).toBe(404);
    expect((await asBruno("POST", `/api/jobs/${anaJob}/analyze`)).statusCode).toBe(404);

    const own = await app.inject({ method: "GET", url: `/api/jobs/${anaJob}`, headers: { cookie: ana.cookie } });
    expect(own.statusCode).toBe(200);
    expect(own.json().job.status).toBe("candidatado"); // nada mudou
  });
});

describe("candidaturas de outra pessoa", () => {
  it("não aparecem no quadro", async () => {
    const res = await asBruno("GET", "/api/applications");
    expect(res.json().items).toEqual([]);
    expect(res.body).not.toContain("anotação privada");
  });

  it("não podem ser criadas, movidas nem apagadas", async () => {
    expect((await asBruno("PATCH", `/api/applications/${anaJob}`, { stage: "encerrada" })).statusCode).toBe(404);
    expect((await asBruno("DELETE", `/api/applications/${anaJob}`)).statusCode).toBe(404);

    const board = await app.inject({ method: "GET", url: "/api/applications", headers: { cookie: ana.cookie } });
    expect(board.json().items[0]).toMatchObject({ stage: "entrevista", notes: "anotação privada" });
  });

  it("os CVs sugeridos são só os da própria pessoa", async () => {
    await app.inject({
      method: "PATCH",
      url: `/api/applications/${anaJob}`,
      headers: { cookie: ana.cookie },
      payload: { resume_used: "CV secreto da Ana" },
    });
    expect((await asBruno("GET", "/api/applications")).json().resumes).toEqual([]);
  });
});

describe("perfil, painel e notificações", () => {
  it("cada um vê só o próprio perfil", async () => {
    const res = await asBruno("GET", "/api/profile");
    expect(res.json().profile.headline).toBe("");
    expect(res.body).not.toContain("Ana");
  });

  it("o painel conta só as vagas da própria pessoa", async () => {
    const res = await asBruno("GET", "/api/dashboard");
    expect(res.json().stats.total).toBe(0);
    expect(res.json().topJobs).toEqual([]);
  });

  it("notificações são individuais e marcar como lidas não afeta os outros", async () => {
    expect((await asBruno("GET", "/api/notifications")).json()).toMatchObject({ notifications: [], unread: 0 });
    await asBruno("POST", "/api/notifications/read");
    const anas = await app.inject({ method: "GET", url: "/api/notifications", headers: { cookie: ana.cookie } });
    expect(anas.json().unread).toBe(1);
  });

  it("excluir a própria conta não apaga nada de outra pessoa", async () => {
    const carla = await registerUser(app);
    await app.inject({ method: "DELETE", url: "/api/auth/me", headers: { cookie: carla.cookie } });
    const own = await app.inject({ method: "GET", url: `/api/jobs/${anaJob}`, headers: { cookie: ana.cookie } });
    expect(own.statusCode).toBe(200);
  });
});
