import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline TEXT NOT NULL DEFAULT '',
  seniority TEXT NOT NULL DEFAULT '',
  desired_roles TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '',
  experience TEXT NOT NULL DEFAULT '',
  languages TEXT NOT NULL DEFAULT '',
  locations TEXT NOT NULL DEFAULT '',
  work_mode TEXT NOT NULL DEFAULT 'qualquer',
  salary_min TEXT NOT NULL DEFAULT '',
  deal_breakers TEXT NOT NULL DEFAULT '',
  resume_text TEXT NOT NULL DEFAULT '',
  search_keywords TEXT NOT NULL DEFAULT '',
  greenhouse_boards TEXT NOT NULL DEFAULT '',
  lever_boards TEXT NOT NULL DEFAULT '',
  min_score INTEGER NOT NULL DEFAULT 70,
  auto_collect_hours INTEGER NOT NULL DEFAULT 0,
  auto_analyze INTEGER NOT NULL DEFAULT 0,
  last_auto_run TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  posted_at TEXT,
  status TEXT NOT NULL DEFAULT 'nova',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, source, external_id)
);

CREATE TABLE IF NOT EXISTS analyses (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  summary TEXT NOT NULL,
  strengths TEXT NOT NULL,
  gaps TEXT NOT NULL,
  red_flags TEXT NOT NULL,
  application_tips TEXT NOT NULL,
  engine TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath, { timeout: 5000 });
// WAL: leituras não esperam escritas (vários usuários ao mesmo tempo).
// synchronous=NORMAL: seguro em WAL e bem mais rápido que o padrão FULL.
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);
db.exec(SCHEMA);

/**
 * Migrações: mudanças no banco depois da primeira versão.
 * Cada uma roda uma vez só, quando a coluna ainda não existe.
 */
function hasColumn(table: string, column: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

if (!hasColumn("jobs", "preview_score")) {
  // A nota grátis (palavras-chave) agora fica na vaga; `analyses` guarda só análises de IA.
  db.exec(`
    ALTER TABLE jobs ADD COLUMN preview_score INTEGER;
    ALTER TABLE jobs ADD COLUMN preview TEXT;
    DELETE FROM analyses WHERE engine = 'palavras-chave';
  `);
}

if (!hasColumn("analyses", "salary_estimate")) {
  // Faixa salarial da vaga (informada ou estimada pela IA), guardada como JSON.
  // Análises feitas antes desta coluna ficam com NULL: a tela simplesmente não mostra o salário.
  db.exec("ALTER TABLE analyses ADD COLUMN salary_estimate TEXT;");
}

if (!hasColumn("jobs", "seniority_level")) {
  // Nível detectado da vaga (0 Estágio … 4 Especialista) e os níveis que o usuário quer ver.
  // Zera as prévias para que todas as vagas sejam recalculadas com a detecção nova.
  db.exec(`
    ALTER TABLE jobs ADD COLUMN seniority_level INTEGER;
    ALTER TABLE profiles ADD COLUMN accepted_levels TEXT NOT NULL DEFAULT '';
    UPDATE jobs SET preview_score = NULL, preview = NULL;
  `);
}

/**
 * Índices: sem eles, toda consulta lê a tabela inteira (de todos os usuários).
 * Cada um segue os filtros das telas: vagas do usuário por situação, por nota,
 * por empresa e por data; notificações não lidas; sessões por usuário; uso da IA no mês.
 * IF NOT EXISTS: seguro rodar a cada inicialização.
 */
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_jobs_user_status   ON jobs (user_id, status);
  CREATE INDEX IF NOT EXISTS idx_jobs_user_preview  ON jobs (user_id, preview_score);
  CREATE INDEX IF NOT EXISTS idx_jobs_user_company  ON jobs (user_id, company);
  CREATE INDEX IF NOT EXISTS idx_jobs_user_created  ON jobs (user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_user_level    ON jobs (user_id, seniority_level);
  CREATE INDEX IF NOT EXISTS idx_notif_user_read    ON notifications (user_id, read);
  CREATE INDEX IF NOT EXISTS idx_sessions_user      ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires   ON sessions (expires_at);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_created   ON ai_usage (created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_user      ON ai_usage (user_id);
`);
db.exec("PRAGMA optimize;");
