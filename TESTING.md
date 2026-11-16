# Testes do Job Analyzer

São **73 testes automatizados** em duas camadas:

| Camada | Ferramenta | Onde | Quantos | O que prova |
|---|---|---|---|---|
| **API** (backend) | Vitest + `app.inject` do Fastify | `job-analyzer-backend/test/` | 59 | Regras de negócio, segurança do login e das sessões, e isolamento entre usuários, direto na API |
| **De ponta a ponta** (E2E) | Playwright no Microsoft Edge | `job-analyzer-frontend/e2e/` | 13 | O que uma pessoa faz de verdade na tela: cadastro, login, quadro de candidaturas, e que duas pessoas não se enxergam |

**Por que duas camadas:** os testes de API são rápidos (cerca de 10 s) e cobrem todos os casos de borda, incluindo os de segurança, que são difíceis de reproduzir clicando. Os de ponta a ponta são mais lentos (cerca de 1,5 min), mas provam que front e back funcionam **juntos**: o proxy do Next, o cookie no navegador, os redirecionamentos e o arrastar e soltar.

## Como rodar

```bash
# Backend (não precisa de nada rodando)
cd job-analyzer-backend
npm test

# Frontend: sobe sozinho um backend e um frontend de teste
cd job-analyzer-frontend
npm run test:e2e
```

## Garantias do ambiente de teste

- **Nunca tocam o banco real.** Cada execução usa um arquivo novo na pasta temporária do sistema (`DATABASE_PATH` em `vitest.config.ts` e `playwright.config.ts`).
- **Nunca gastam a cota da IA.** A chave da Anthropic fica vazia. O primeiro teste confere que a IA está desligada e que o banco não é o `data/job-analyzer.db`. Se alguém quebrar isso, ele falha antes de tudo.
- **Não atrapalham o `npm run dev`.** Os testes E2E usam portas próprias (backend 4120, frontend 3120) e uma pasta de build separada (`.next-e2e`).
- **Não baixam navegador.** O Playwright usa o Edge já instalado no Windows (`channel: "msedge"`).

## Como os testes da API funcionam

- `src/app.ts` exporta `buildApp()`, que monta a API inteira **sem abrir porta**. O `server.ts` usa a mesma função e faz o `listen`. Os testes chamam `buildApp()` e usam `app.inject()`, que simula requisições HTTP reais (com cookies e IP) em memória. Assim o que é testado é exatamente o que roda em produção, sem servidor nem rede.
- `test/helpers.ts`:
  - `registerUser` cria um usuário com e-mail único e devolve o cookie;
  - `createJob` cola uma vaga;
  - `randomIp` dá um IP diferente para cada chamada, para os limites por IP de um teste não afetarem outro.
- Os arquivos rodam um de cada vez (`singleFork`), porque dividem o mesmo banco temporário.

---

## Testes da API (59)

### `test/auth.test.ts`: login, cadastro e sessões (19)

| Teste | O que garante |
|---|---|
| usa um banco temporário e a IA desligada | Os testes nunca mexem no banco real nem gastam dinheiro |
| cria a conta e já entra | Cadastro devolve sessão válida |
| guarda a senha só como hash scrypt com salt | A senha nunca fica legível no banco |
| recusa e-mail repetido, inválido, senha curta e senha gigante | Validação do cadastro (409 e 400), incluindo o limite de 128 caracteres |
| limita cadastros em massa vindos do mesmo IP | O 11º cadastro do mesmo IP recebe 429 |
| entra com a senha certa e o e-mail em qualquer caixa | "Murilo@X.com" e "murilo@x.com" são a mesma conta |
| dá a mesma resposta para senha errada e para e-mail que não existe | Não revela quem tem conta; nenhum cookie é criado |
| bloqueia o e-mail depois de 5 senhas erradas, mesmo com a senha certa | Proteção contra força bruta numa conta |
| bloqueia o IP que testa senhas em muitos e-mails diferentes | Proteção contra *password spraying*; outro IP continua entrando |
| envia o cookie com httpOnly, SameSite=Lax e path / | Atributos de segurança do cookie e formato do token |
| guarda no banco só o hash do token, nunca o token | Cópia do banco não dá acesso |
| um novo login no mesmo navegador invalida o token antigo | Proteção contra *session fixation* |
| recusa sem cookie, com token inventado ou com formato estranho | Inclusive tentativa de SQL injection no cookie |
| não aceita o hash guardado no banco como se fosse o token | Quem tem o banco não consegue montar um cookie válido |
| logout apaga a sessão: o mesmo cookie não serve mais | Sair invalida de verdade, não só no navegador |
| sessão vencida não entra | Validade de 30 dias respeitada |
| toda rota privada responde 401 sem login | Percorre as **17 rotas** privadas (vagas, candidaturas, perfil, painel, fontes, notificações, excluir conta) |
| respostas da API não ficam em cache | `Cache-Control: no-store` e `nosniff` |
| excluir a conta apaga usuário, sessões e vagas | Direito de apagar os próprios dados (LGPD) |

### `test/isolation.test.ts`: uma pessoa não acessa dados de outra (9)

A Ana cria vaga, candidatura (com anotação e contato), perfil e notificação. O Bruno tenta tudo:

| Teste | O que garante |
|---|---|
| vagas de outra pessoa não aparecem na lista nem na busca | Nem pesquisando pelo título |
| não podem ser lidas, alteradas, excluídas nem analisadas | 404 em GET, PATCH, DELETE e analisar; a vaga da Ana continua igual |
| candidaturas de outra pessoa não aparecem no quadro | Nem as anotações |
| não podem ser criadas, movidas nem apagadas | 404; a etapa e as notas da Ana continuam iguais |
| os CVs sugeridos são só os da própria pessoa | A sugestão do campo "CV usado" não vaza |
| cada um vê só o próprio perfil | Nem o currículo de outra pessoa |
| o painel conta só as vagas da própria pessoa | Números e "melhores vagas" individuais |
| notificações são individuais e marcar como lidas não afeta os outros | |
| excluir a própria conta não apaga nada de outra pessoa | A cascata para no usuário certo |

### `test/applications.test.ts`: quadro de candidaturas (9)

| Teste | O que garante |
|---|---|
| vaga nova não está no quadro; salvar coloca em "Salva" | Com um evento no histórico |
| "Me candidatei" coloca em "Candidatei" com a data de hoje | Data no fuso local, não em UTC (que viraria o dia às 21h no Brasil) |
| mover de etapa grava o histórico e mantém a situação da vaga em dia | E salvar só as anotações não cria evento nem muda a etapa |
| clicar "Me candidatei" de novo não faz a etapa voltar | Quem está em "Entrevista" não volta para "Candidatei" |
| descartar tira do quadro, mas a candidatura volta inteira ao salvar de novo | Etapa e anotações preservadas |
| "Tirar do quadro" apaga candidatura e histórico e a vaga volta a ser nova | E apagar de novo dá 404 |
| excluir a vaga apaga a candidatura junto | Sem candidatura "órfã" |
| sugere os CVs já usados, o mais usado primeiro | |
| valida etapa, data e tamanho dos campos | Etapa inexistente, data inválida, anotação gigante, vaga inexistente |

### `test/rules.test.ts`: regras da nota grátis (11)

| Teste | O que garante |
|---|---|
| detecção de senioridade pelo título (6 casos) | Estágio, Júnior, "Jr", Pleno, Sênior e "Pleno/Sênior" (fica com o menor) |
| sem nível no título, usa os anos de experiência pedidos | "5+ anos" na descrição |
| sem pista nenhuma, não inventa nível | |
| vaga que combina tira nota alta | Habilidades + cargo dão 85 ou mais |
| cada item que a pessoa não aceita derruba a nota | Exatamente −25 |
| vaga dois níveis acima perde 40 pontos | Júnior vendo vaga Sênior |

### `test/blockers.test.ts`: filtros de bloqueio (11)

| Teste | O que garante |
|---|---|
| sem filtro ligado, nada é bloqueado | Bloqueio é opcional |
| bloqueio pronto de residência pega inglês e espanhol, sem acento e caixa | E não bloqueia quem **oferece** visto |
| bloqueio de security clearance e de 100% presencial | Híbrido não é bloqueado |
| termos próprios do usuário, com o motivo dizendo o que encontrou | |
| limite de anos: esconde quem pede o limite ou mais | "3+ anos", "5 years"; 1 ano ou sem exigência passam |
| bloqueio pronto que não existe é ignorado | |
| ligar o filtro esconde a vaga das listas e ela aparece em "Bloqueadas" | Com a contagem |
| a vaga bloqueada mostra o motivo e some do painel | |
| desligar o filtro traz a vaga de volta | Nada é apagado |
| recusa bloqueio pronto inválido e limite de anos fora da faixa | |
| a tela recebe a lista de bloqueios prontos com os termos | |

---

## Testes de ponta a ponta (13)

Rodam num navegador de verdade (Edge, sem janela), contra um backend e um frontend que sobem só para os testes.

### `e2e/auth.spec.ts`: login e segurança na tela (7)

| Teste | O que garante |
|---|---|
| cria conta, sai e entra de novo | O ciclo completo pela interface, caindo no painel |
| senha errada mostra erro genérico e não entra | Mesma mensagem para e-mail inexistente |
| área logada sem sessão manda para o login | /painel, /vagas, /candidaturas e /perfil |
| o cookie de sessão não é acessível por JavaScript | `document.cookie` não mostra a sessão; httpOnly e SameSite=Lax no navegador |
| depois de sair, voltar no navegador não mostra dados | A API responde 401 e a página redireciona |
| páginas trazem cabeçalhos de segurança | X-Frame-Options, nosniff, Referrer-Policy |
| uma pessoa não vê nem mexe nos dados de outra | **Dois navegadores separados**: o Bruno não vê o quadro da Ana, abrir a vaga dela mostra "Vaga não encontrada", mover ou apagar dá 404, e a Ana continua com tudo |

### `e2e/candidaturas.spec.ts`: quadro de candidaturas (5)

| Teste | O que garante |
|---|---|
| quadro vazio explica o que fazer | Mensagem e link para as vagas |
| "Me candidatei" na vaga coloca no quadro e o formulário salva | CV, pretensão, contato e anotações salvos e visíveis no cartão |
| arrastar o cartão muda a etapa e continua lá depois de recarregar | Arrastar e soltar de verdade, e os números do topo atualizados |
| abrir o cartão, trocar a etapa pelo formulário e ver o histórico na vaga | O caminho de quem não arrasta (celular) |
| tirar do quadro pede confirmação e remove o cartão | |

### `e2e/bloqueios.spec.ts`: filtros de bloqueio (1)

| Teste | O que garante |
|---|---|
| ligar um filtro de bloqueio esconde a vaga e mostra o motivo | Marca o bloqueio no perfil, a vaga some da lista, aparece em "Bloqueadas" e a tela da vaga explica o motivo |

---

## Bug real que os testes encontraram

Na primeira rodada, a rota de atualizar candidatura **quebrava com erro 500**: o SQLite recusa parâmetros que a consulta não usa, e o `UPDATE` recebia um `:user` que só o `INSERT` usava. Foi corrigido antes do commit.

Os testes E2E também mostraram que, atrás do proxy do Next, todos os usuários de uma mesma máquina contam como **um IP só**. Por isso o limite de cadastros por IP é configurável (`REGISTER_LIMIT_PER_IP`) e foi documentado em [SECURITY.md](SECURITY.md).

## O que ainda não está coberto

- **Coleta de vagas** (Gupy, GitHub, Remotive, Greenhouse, Lever): depende de sites externos. O próximo passo é testar com respostas gravadas (*mocks* do `fetch`).
- **Análise com IA:** de propósito, nenhum teste chama a Anthropic. Dá para testar com um cliente falso que devolve um JSON fixo, cobrindo a validação do schema e o limite de gasto.
- **Agendador** (busca automática a cada X horas).
- **Telas de perfil e configurações** no E2E.
- **Tamanho de celular** no E2E (o Playwright permite rodar os mesmos testes com `devices["Pixel 7"]`).
- **Rodar em CI** (GitHub Actions) a cada push.
