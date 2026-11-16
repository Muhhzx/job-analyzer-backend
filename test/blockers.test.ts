import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blockReasons } from "../src/blockers.js";
import { type Api, createApi, registerUser } from "./helpers.js";

const off = { block_presets: "", block_terms: "", block_max_years: 0 };
const job = (description: string, title = "Software Engineer") => ({ title, description });

describe("regras de bloqueio", () => {
  it("sem filtro ligado, nada é bloqueado", () => {
    expect(blockReasons(off, job("Must be a permanent resident. Security clearance required."))).toEqual([]);
  });

  it("bloqueio pronto de residência pega inglês e espanhol, sem acento e caixa", () => {
    const p = { ...off, block_presets: "residencia" };
    expect(blockReasons(p, job("You MUST be a Permanent Resident of New Zealand."))).toHaveLength(1);
    expect(blockReasons(p, job("Requisito: residencia permanente en España"))).toHaveLength(1);
    expect(blockReasons(p, job("We offer visa sponsorship and relocation."))).toEqual([]);
  });

  it("bloqueio de security clearance e de 100% presencial", () => {
    const p = { ...off, block_presets: "clearance,presencial" };
    expect(blockReasons(p, job("Baseline clearance required to start."))[0]).toContain("security clearance");
    expect(blockReasons(p, job("Modelo presencial em Curitiba"))[0]).toContain("100% presencial");
    expect(blockReasons(p, job("Modelo híbrido, 2 dias no escritório"))).toEqual([]);
  });

  it("termos próprios do usuário, com o motivo dizendo o que encontrou", () => {
    const p = { ...off, block_terms: "Curitiba, PHP" };
    expect(blockReasons(p, job("Vaga em curitiba com Laravel e PHP"))).toEqual(["Contém “Curitiba”", "Contém “PHP”"]);
  });

  it("limite de anos: esconde quem pede o limite ou mais", () => {
    const p = { ...off, block_max_years: 3 };
    expect(blockReasons(p, job("Requisitos: 3+ anos de experiência com C#"))).toHaveLength(1);
    expect(blockReasons(p, job("5 years of experience with Angular"))).toHaveLength(1);
    expect(blockReasons(p, job("1 ano de experiência com Angular"))).toEqual([]);
    expect(blockReasons(p, job("Sem experiência exigida"))).toEqual([]);
  });

  it("bloqueio pronto que não existe é ignorado", () => {
    expect(blockReasons({ ...off, block_presets: "inventado" }, job("qualquer coisa"))).toEqual([]);
  });
});

describe("vagas bloqueadas na API", () => {
  let app: Api;
  let cookie: string;
  const call = (method: string, url: string, payload?: object) =>
    app.inject({ method: method as "GET", url, headers: { cookie }, payload });
  const list = async (filter: string) => (await call("GET", `/api/jobs?filter=${filter}`)).json();

  beforeAll(async () => {
    app = await createApi();
    ({ cookie } = await registerUser(app));
    await call("PUT", "/api/profile", { skills: "Angular, C#", desired_roles: "Developer" });
    const base = "Angular and C# developer for banking APIs, tests and CI/CD pipelines. ".repeat(2);
    await call("POST", "/api/jobs", { title: "Developer NZ", company: "Kiwi", description: `${base} Must be a NZ citizen.` });
    await call("POST", "/api/jobs", { title: "Developer BR", company: "Brasil", description: base });
  });
  afterAll(async () => {
    await app.close();
  });

  it("ligar o filtro esconde a vaga das listas e ela aparece em “Bloqueadas”", async () => {
    expect((await list("todas")).total).toBe(2);

    const res = await call("PUT", "/api/profile", { block_presets: "residencia" });
    expect(res.statusCode).toBe(200);

    const all = await list("todas");
    expect(all.jobs.map((j: { title: string }) => j.title)).toEqual(["Developer BR"]);
    expect(all.counts.bloqueadas).toBe(1);

    const blocked = await list("bloqueadas");
    expect(blocked.jobs.map((j: { title: string }) => j.title)).toEqual(["Developer NZ"]);
  });

  it("a vaga bloqueada mostra o motivo e some do painel", async () => {
    const id = (await list("bloqueadas")).jobs[0].id;
    const detail = (await call("GET", `/api/jobs/${id}`)).json().job;
    expect(detail.preview.blockedBy[0]).toContain("nz citizen");

    const dash = (await call("GET", "/api/dashboard")).json();
    expect(dash.stats.total).toBe(1);
  });

  it("desligar o filtro traz a vaga de volta", async () => {
    await call("PUT", "/api/profile", { block_presets: "" });
    expect((await list("todas")).total).toBe(2);
    expect((await list("bloqueadas")).total).toBe(0);
  });

  it("recusa bloqueio pronto inválido e limite de anos fora da faixa", async () => {
    expect((await call("PUT", "/api/profile", { block_presets: "residencia,hack" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/profile", { block_max_years: 50 })).statusCode).toBe(400);
  });

  it("a tela recebe a lista de bloqueios prontos com os termos", async () => {
    const { blockPresets } = (await call("GET", "/api/profile")).json();
    expect(blockPresets.map((p: { id: string }) => p.id)).toEqual(["residencia", "clearance", "presencial"]);
    expect(blockPresets[0].terms.length).toBeGreaterThan(5);
  });
});
