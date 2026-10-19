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
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(SCHEMA);
