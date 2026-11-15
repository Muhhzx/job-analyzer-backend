# Segurança do Job Analyzer

Este documento explica **cada proteção** do sistema: o que ela faz, **qual ataque ela impede**, **onde está no código** e **qual teste prova que funciona**.

## Visão geral da arquitetura

```
Navegador ──HTTPS──▶ Frontend (Next.js, porta 3000)
                       │  cabeçalhos de segurança em todas as páginas
                       │  /api/* é repassado (rewrite) para o backend
                       ▼
                     Backend (Fastify, só em 127.0.0.1:4000)
                       │  app.ts: Cache-Control no-store, nosniff, trustProxy
                       │  requireAuth: lê o cookie → hash → sessão no banco → request.user
                       │  rotas: toda consulta filtra por request.user.id
                       ▼
                     SQLite (data/job-analyzer.db, fora do git)
```

**Decisões que sustentam o resto:**

1. **O navegador só fala com o frontend.** O Next repassa `/api/*` para o backend, então o cookie de sessão fica no mesmo domínio da página. Não precisa de CORS, e o backend nunca fica exposto direto na internet: ele escuta só em `127.0.0.1`.
2. **A identidade vem só da sessão, nunca do que o cliente manda.** Nenhuma rota recebe `userId` no corpo ou na URL. O `requireAuth` descobre quem é o usuário pelo cookie e coloca em `request.user`. Toda consulta usa esse id.
3. **Toda entrada é validada com Zod antes de chegar no banco**, e todo SQL usa parâmetros (`?` ou `:nome`), nunca texto concatenado com dado do usuário.

---

## 1. Senhas

| O quê | Por quê | Onde |
|---|---|---|
| **scrypt com salt aleatório de 16 bytes** por senha | Se o banco vazar, as senhas não aparecem. O scrypt é lento e usa memória de propósito, o que torna inviável testar bilhões de senhas. O salt impede tabelas prontas (rainbow tables) e faz duas senhas iguais terem hashes diferentes. | `src/auth.ts` → `hashPassword` |
| **Comparação em tempo constante** (`timingSafeEqual`) | Uma comparação comum para no primeiro caractere diferente. Medindo o tempo, dá para adivinhar o hash aos poucos. | `src/auth.ts` → `verifyPassword` |
| **Senha de 8 a 128 caracteres** | O mínimo evita senhas triviais. O máximo impede alguém de mandar uma "senha" de 1 MB para deixar o scrypt lento e travar o servidor (negação de serviço). | `src/routes/auth.ts` → `RegisterBody`, `LoginBody` |

**Testes:** "guarda a senha só como hash scrypt com salt", "recusa e-mail repetido, inválido, senha curta e senha gigante".

## 2. Login sem revelar quem tem conta

| O quê | Por quê | Onde |
|---|---|---|
| **Mesma mensagem** ("E-mail ou senha incorretos.") para senha errada e e-mail inexistente | Mensagens diferentes ("e-mail não encontrado") deixariam um atacante montar a lista de quem usa o sistema e depois atacar só essas contas. | `src/routes/auth.ts` → `/login` |
| **Hash falso** (`DUMMY_HASH`) quando o e-mail não existe | Mesmo com a mesma mensagem, se o login sem conta respondesse na hora e o com conta demorasse (por causa do scrypt), o **tempo** revelaria quem tem conta. Rodando o scrypt contra um hash falso, os dois casos demoram o mesmo. | `src/auth.ts` → `verifyPassword(password, undefined)` |

**Testes:** "dá a mesma resposta para senha errada e para e-mail que não existe" (back) e "senha errada mostra erro genérico e não entra" (E2E).

> **Limitação conhecida:** o cadastro avisa "Esse e-mail já está cadastrado", o que revela se um e-mail tem conta. É uma troca comum entre segurança e usabilidade. O limite de cadastros por IP (abaixo) dificulta usar isso em massa.

## 3. Limite de tentativas (força bruta)

| Limite | Por quê |
|---|---|
| **5 senhas erradas por e-mail** em 15 min → bloqueia aquele e-mail (429) | Impede testar milhares de senhas numa conta específica. Bloqueia até a senha certa durante a janela, senão o robô seguiria tentando. |
| **20 senhas erradas por IP** em qualquer e-mail → bloqueia aquele IP | Impede o ataque "uma senha comum em milhares de e-mails" (password spraying), que o limite por e-mail não pega. |
| **Cadastros por IP** (`REGISTER_LIMIT_PER_IP`, padrão 10) | Impede criar contas em massa (spam, abuso da cota de IA, enumeração de e-mails). |

**Como funciona:** a classe `AttemptLimiter` (`src/auth.ts`) guarda contagens em memória por chave (e-mail ou IP), com janela de 15 minutos. Ela limpa as chaves velhas quando passa de 10 mil, para a memória não crescer sem fim.

**IP real atrás do proxy:** como tudo chega pelo Next, a conexão vem sempre de `127.0.0.1`. O Fastify foi configurado com `trustProxy: ["127.0.0.1", "::1"]` (`src/app.ts`), então `request.ip` vem do cabeçalho `X-Forwarded-For` que o Next envia, **mas só quando a conexão chega do próprio servidor**. Assim ninguém de fora consegue mentir o IP mandando esse cabeçalho.

> **Limitações conhecidas:** os limites ficam em memória, então zeram se o backend reiniciar e só valem com **um** processo. Para rodar várias instâncias, o próximo passo é guardar as contagens no Redis ou no banco. Pessoas na mesma rede (uma empresa, por exemplo) dividem o mesmo IP e, portanto, o mesmo limite de cadastros.

**Testes:** "bloqueia o e-mail depois de 5 senhas erradas, mesmo com a senha certa", "bloqueia o IP que testa senhas em muitos e-mails diferentes" (e confere que outro IP continua entrando) e "limita cadastros em massa vindos do mesmo IP".

## 4. Sessões

| O quê | Por quê | Onde |
|---|---|---|
| **Token aleatório de 256 bits** (`crypto.randomBytes(32)`) | Impossível de adivinhar. Não carrega dados do usuário (diferente de um JWT), então não há o que decodificar ou forjar. | `startSession` |
| **O banco guarda só o SHA-256 do token** | Se alguém copiar o arquivo do banco (backup, notebook roubado), não consegue usar as sessões: o banco tem o hash, e o servidor só aceita o token original. Funciona como uma senha. Usamos SHA-256, e não scrypt, porque o token já é aleatório e longo (não dá para testar todas as possibilidades) e é conferido a cada requisição, então precisa ser rápido. | `hashToken`, `userFromRequest` |
| **Migração automática** das sessões antigas | As sessões criadas antes dessa mudança (com o token em texto) foram convertidas para hash na inicialização, e ninguém precisou entrar de novo. | `src/db.ts`, migração `sessions.hashed` |
| **Token novo a cada login**, apagando o anterior do mesmo navegador | Evita *session fixation*: se alguém conseguisse plantar um token no seu navegador antes de você entrar, ele não continuaria valendo depois do login. | `startSession` |
| **Formato conferido** (64 caracteres hexadecimais) antes de consultar o banco | Cookie com lixo ou tentativa de injeção é recusado sem nem chegar na consulta. | `userFromRequest` |
| **Validade de 30 dias**, conferida a cada requisição, e limpeza das vencidas de hora em hora | Sessão esquecida aberta não vale para sempre. | `userFromRequest`, `cleanupExpiredSessions` |
| **Logout apaga a sessão no banco** | Não basta apagar o cookie: se alguém tivesse copiado o token, ele continuaria valendo. Apagando no banco, o token morre de verdade. | `endSession` |

**Cookie:**

| Atributo | Por quê |
|---|---|
| `httpOnly` | O JavaScript da página não consegue ler o cookie. Mesmo se um script malicioso rodasse na página (XSS), ele não conseguiria roubar a sessão. |
| `SameSite=Lax` | O navegador não envia o cookie em requisições `POST`, `PATCH` ou `DELETE` vindas de **outros sites**. É a proteção contra CSRF (outro site fazendo ações na sua conta sem você saber). `Lax`, e não `Strict`, para que abrir um link do app vindo de um e-mail já entre logado. |
| `Secure` em produção | O cookie só trafega por HTTPS, sem vazar em rede aberta. Fica desligado em desenvolvimento porque `localhost` usa HTTP. |
| `path=/` | Vale para o app inteiro, e só para ele. |

**Testes:** "envia o cookie com httpOnly, SameSite=Lax e path /", "guarda no banco só o hash do token, nunca o token", "não aceita o hash guardado no banco como se fosse o token", "um novo login no mesmo navegador invalida o token antigo", "recusa sem cookie, com token inventado ou com formato estranho", "logout apaga a sessão", "sessão vencida não entra", "o cookie de sessão não é acessível por JavaScript" (E2E) e "depois de sair, voltar no navegador não mostra dados" (E2E).

## 5. Isolamento entre usuários (autorização)

Esta é a proteção mais importante de um sistema com várias pessoas: **ninguém pode ver ou mexer nos dados de outra pessoa**, mesmo trocando o número da vaga na URL (ataque conhecido como IDOR).

**Como está feito:**

- **Rotas de vaga:** usam `getOwnedJob(userId, jobId)`, que busca com `WHERE id = ? AND user_id = ?`. Vaga de outra pessoa simplesmente "não existe" (404).
- **Rotas de candidatura:** conferem `ownsJob(userId, jobId)` antes de qualquer leitura ou escrita.
- **Listas** (vagas, quadro, CVs sugeridos, painel, notificações, perfil): toda consulta começa com `user_id = ?`.
- **Responde 404, e não 403**, para dados de outra pessoa. Um 403 confirmaria que o id existe, revelando informação.
- **Exclusão em cascata** (`ON DELETE CASCADE`): excluir a conta apaga sessões, vagas, análises, candidaturas e notificações daquela pessoa, e só dela.
- **Os índices começam por `user_id`.** Além de rápido, isso deixa claro no próprio banco que os dados são sempre lidos por pessoa.

**Testes (`test/isolation.test.ts` e E2E):** a Ana cria vaga, candidatura com anotação privada, perfil e notificação. O Bruno tenta listar, buscar, abrir, alterar, excluir, analisar, mover no quadro e apagar a candidatura, e recebe 404 ou lista vazia em tudo. No fim, o teste confere que nada da Ana mudou. Também confere que o painel e os CVs sugeridos são individuais, que marcar notificações como lidas não afeta outra pessoa e que excluir uma conta não apaga dados de outra. O teste E2E repete isso com **dois navegadores separados**.

## 6. Validação de entrada e SQL

| O quê | Por quê |
|---|---|
| **Zod em todas as rotas** (corpo e query string), com tamanho máximo nos textos | Dado fora do formato é recusado com 400 antes de chegar na lógica. Os limites (nome 100, e-mail 254, anotações 5.000, currículo 60.000) impedem encher o banco ou a memória. |
| **SQL sempre com parâmetros** | Impede *SQL injection*: o valor digitado nunca vira parte do comando SQL. As poucas partes dinâmicas (filtros e ordenação) vêm de listas fixas no código, nunca do usuário. |
| **Erro interno não vaza detalhes** | Erro 500 responde só "Erro interno no servidor." O detalhe (stack trace, SQL) vai para o log do servidor, não para o navegador. |

## 7. Cabeçalhos HTTP

**Na API** (`src/app.ts`, em todas as respostas):

| Cabeçalho | Por quê |
|---|---|
| `Cache-Control: no-store` | As respostas têm dados pessoais (vagas, perfil, anotações). Sem isso, um proxy ou o cache do navegador poderiam guardar e mostrar esses dados depois do logout ou para outra pessoa no mesmo computador. |
| `X-Content-Type-Options: nosniff` | O navegador não tenta "adivinhar" o tipo do conteúdo, o que poderia fazer um JSON ser executado como script. |

**No frontend** (`next.config.ts`, em todas as páginas):

| Cabeçalho | Por quê |
|---|---|
| `X-Frame-Options: DENY` | Nenhum outro site pode abrir o app dentro de um iframe. Impede *clickjacking*: um site falso colocando o app invisível por cima de um botão para você clicar sem saber. |
| `X-Content-Type-Options: nosniff` | Mesmo motivo da API. |
| `Referrer-Policy: strict-origin-when-cross-origin` | Ao clicar num link externo (a vaga original, por exemplo), o outro site não recebe o endereço completo da página (que pode ter ids e filtros), só o domínio. |
| `Permissions-Policy: camera=(), microphone=(), geolocation=()` | O app não usa câmera, microfone nem localização, então bloqueia de vez. Se algum script malicioso tentasse usar, o navegador recusaria. |

**Testes:** "respostas da API não ficam em cache" (back) e "páginas trazem cabeçalhos de segurança" (E2E).

## 8. Privacidade e segredos

- `.env` (chave da Anthropic), o banco (`data/`), certificados e `node_modules` estão no `.gitignore` e **nunca vão para o git**.
- **Nenhuma vaga vai para a IA sem o usuário pedir** (ou ligar a análise automática). O perfil e o currículo só são enviados à Anthropic nessas análises.
- **Teto de gasto com IA** (`AI_MONTHLY_BUDGET_USD`, `AI_MONTHLY_MAX_ANALYSES`): mesmo com abuso, a conta não passa do limite do mês.
- **Não faz scraping de sites que proíbem** (LinkedIn, Catho) e não pede senha de outros serviços.
- **Os testes nunca tocam o banco real nem gastam IA:** usam um banco temporário e a chave da Anthropic vazia. Um teste confere isso antes de tudo ("usa um banco temporário e a IA desligada").

---

## O que ainda falta para colocar na internet

| Item | Por quê |
|---|---|
| **HTTPS** (Vercel, Nginx, Caddy ou IIS com certificado) | Sem HTTPS, senha e cookie trafegam abertos. O cookie já vira `Secure` sozinho com `NODE_ENV=production`. |
| **Limites no Redis ou no banco** | Os limites de login em memória só valem com um processo e zeram ao reiniciar. |
| **Content-Security-Policy (CSP)** | Restringe de onde a página pode carregar scripts: uma segunda barreira contra XSS. Precisa de ajuste fino com o Next, por isso ainda não está ligada. |
| **Backup do banco** criptografado | Para não perder dados. |
| **Monitoramento de erros** (Sentry, por exemplo) e alerta de muitos 401/429 | Para perceber um ataque em andamento. |
| **Trocar senha** e **"sair de todos os dispositivos"** | Hoje não existem. Com o desenho atual de sessões no banco, os dois são simples de fazer: basta apagar as sessões do usuário. |
| **Verificação de e-mail** no cadastro | Hoje qualquer e-mail é aceito sem confirmação. |
| `npm audit` e atualização de dependências | Para corrigir falhas conhecidas nas bibliotecas. |
