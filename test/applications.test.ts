import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Api, createApi, createJob, registerUser } from "./helpers.js";

let app: Api;
let cookie: string;
beforeAll(async () => {
  app = await createApi();
  ({ cookie } = await registerUser(app));
});
afterAll(async () => {
  await app.close();
});

const call = (method: string, url: string, payload?: object) =>
  app.inject({ method: method as "GET", url, headers: { cookie }, payload });
const job = async (id: number) => (await call("GET", `/api/jobs/${id}`)).json().job;
const board = async () => (await call("GET", "/api/applications")).json();

describe("quadro de candidaturas", () => {
  it("vaga nova não está no quadro; salvar coloca em “Salva”", async () => {
    const id = await createJob(app, cookie);
    expect((await job(id)).application).toBeNull();

    await call("PATCH", `/api/jobs/${id}`, { status: "salva" });
    const j = await job(id);
    expect(j.application.stage).toBe("salva");
    expect(j.application.applied_at).toBeNull();
    expect(j.applicationEvents.map((e: { stage: string }) => e.stage)).toEqual(["salva"]);
  });

  it("“Me candidatei” coloca em “Candidatei” com a data de hoje", async () => {
    const id = await createJob(app, cookie);
    await call("PATCH", `/api/jobs/${id}`, { status: "candidatado" });
    const { application } = await job(id);
    expect(application.stage).toBe("candidatei");
    expect(application.applied_at).toBe(new Date().toLocaleDateString("sv-SE"));
  });

  it("mover de etapa grava o histórico e mantém a situação da vaga em dia", async () => {
    const id = await createJob(app, cookie);
    await call("PATCH", `/api/applications/${id}`, { stage: "salva" });
    const res = await call("PATCH", `/api/applications/${id}`, {
      stage: "teste",
      resume_used: "CV .NET",
      salary_expectation: "R$ 6.000 CLT",
      contact: "Mauro (LinkedIn)",
      notes: "Teste até sexta",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().application).toMatchObject({ stage: "teste", resume_used: "CV .NET", notes: "Teste até sexta" });
    expect(res.json().events.map((e: { stage: string }) => e.stage)).toEqual(["salva", "teste"]);
    expect((await job(id)).status).toBe("candidatado");

    // Salvar só as anotações não muda a etapa nem cria evento.
    const notes = await call("PATCH", `/api/applications/${id}`, { notes: "Passei no teste" });
    expect(notes.json().events).toHaveLength(2);
    expect(notes.json().application.stage).toBe("teste");
  });

  it("clicar “Me candidatei” de novo não faz a etapa voltar", async () => {
    const id = await createJob(app, cookie);
    await call("PATCH", `/api/applications/${id}`, { stage: "entrevista" });
    await call("PATCH", `/api/jobs/${id}`, { status: "candidatado" });
    expect((await job(id)).application.stage).toBe("entrevista");
  });

  it("descartar tira do quadro, mas a candidatura volta inteira ao salvar de novo", async () => {
    const id = await createJob(app, cookie, "Vaga que volta");
    await call("PATCH", `/api/applications/${id}`, { stage: "proposta", notes: "R$ 7 mil" });

    await call("PATCH", `/api/jobs/${id}`, { status: "descartada" });
    expect((await board()).items.some((i: { job_id: number }) => i.job_id === id)).toBe(false);

    await call("PATCH", `/api/jobs/${id}`, { status: "salva" });
    const item = (await board()).items.find((i: { job_id: number }) => i.job_id === id);
    expect(item).toMatchObject({ stage: "proposta", notes: "R$ 7 mil" });
  });

  it("“Tirar do quadro” apaga candidatura e histórico e a vaga volta a ser nova", async () => {
    const id = await createJob(app, cookie);
    await call("PATCH", `/api/applications/${id}`, { stage: "candidatei" });
    expect((await call("DELETE", `/api/applications/${id}`)).statusCode).toBe(200);
    const j = await job(id);
    expect(j.status).toBe("nova");
    expect(j.application).toBeNull();
    expect(j.applicationEvents).toEqual([]);
    expect((await call("DELETE", `/api/applications/${id}`)).statusCode).toBe(404);
  });

  it("excluir a vaga apaga a candidatura junto", async () => {
    const id = await createJob(app, cookie);
    await call("PATCH", `/api/applications/${id}`, { stage: "teste" });
    await call("DELETE", `/api/jobs/${id}`);
    expect((await board()).items.some((i: { job_id: number }) => i.job_id === id)).toBe(false);
  });

  it("sugere os CVs já usados, o mais usado primeiro", async () => {
    for (const cv of ["CV Angular", "CV Angular", "CV Python"]) {
      const id = await createJob(app, cookie);
      await call("PATCH", `/api/applications/${id}`, { stage: "candidatei", resume_used: cv });
    }
    const { resumes } = await board();
    expect(resumes.indexOf("CV Angular")).toBeLessThan(resumes.indexOf("CV Python"));
  });

  it("valida etapa, data e tamanho dos campos", async () => {
    const id = await createJob(app, cookie);
    expect((await call("PATCH", `/api/applications/${id}`, { stage: "contratado" })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/applications/${id}`, { applied_at: "ontem" })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/applications/${id}`, { notes: "x".repeat(5001) })).statusCode).toBe(400);
    expect((await call("PATCH", "/api/applications/999999", { stage: "teste" })).statusCode).toBe(404);
  });
});
