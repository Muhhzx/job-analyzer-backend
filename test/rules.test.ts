import { describe, expect, it } from "vitest";
import { computePreview } from "../src/preview.js";
import type { Profile } from "../src/profile.js";
import { detectJobLevel } from "../src/seniority.js";

describe("detecção de senioridade", () => {
  it.each([
    ["Estágio em Desenvolvimento", 0],
    ["Desenvolvedor Júnior .NET", 1],
    ["Dev Jr Angular", 1],
    ["Desenvolvedor Pleno", 2],
    ["Engenheiro Sênior", 3],
    ["Desenvolvedor Pleno/Sênior", 2],
  ])("“%s” → nível %i pelo título", (title, level) => {
    expect(detectJobLevel(title)).toMatchObject({ level, source: "título" });
  });

  it("sem nível no título, usa os anos de experiência pedidos", () => {
    const r = detectJobLevel("Desenvolvedor Full Stack", "Requisitos: 5+ anos de experiência com C#");
    expect(r.source).toBe("experiência pedida");
    expect(r.level).not.toBeNull();
  });

  it("sem pista nenhuma, não inventa nível", () => {
    expect(detectJobLevel("Desenvolvedor Full Stack", "Venha trabalhar conosco")).toMatchObject({ level: null });
  });
});

describe("prévia grátis", () => {
  // Só os campos que a prévia usa; o resto do perfil não importa aqui.
  const profile = {
    accepted_levels: "",
    block_presets: "",
    block_terms: "",
    block_max_years: 0,
    skills: "Angular, C#, SQL, Docker, TypeScript",
    desired_roles: "Desenvolvedor",
    seniority: "Júnior",
    deal_breakers: "presencial",
  } as Profile;

  it("vaga que combina tira nota alta", () => {
    const p = computePreview(profile, {
      title: "Desenvolvedor Júnior Angular",
      description: "Angular, TypeScript, C#, SQL Server e Docker.",
    });
    expect(p.score).toBeGreaterThanOrEqual(85);
    expect(p.roleMatched).toBe("Desenvolvedor");
  });

  it("cada item que a pessoa não aceita derruba a nota", () => {
    const base = { title: "Desenvolvedor Júnior", description: "Angular e C#." };
    const ok = computePreview(profile, base).score;
    const bad = computePreview(profile, { ...base, description: "Angular e C#. Trabalho presencial." }).score;
    expect(ok - bad).toBe(25);
  });

  it("vaga dois níveis acima perde 40 pontos", () => {
    const desc = "Angular, TypeScript, C#, SQL e Docker.";
    const junior = computePreview(profile, { title: "Desenvolvedor Júnior", description: desc }).score;
    const senior = computePreview(profile, { title: "Desenvolvedor Sênior", description: desc }).score;
    expect(junior - senior).toBe(40);
  });
});
