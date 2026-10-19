import { db } from "./db.js";

/**
 * Canais de notificação. Hoje só existe o aviso dentro do app; Telegram,
 * e-mail ou WhatsApp entram aqui como novos canais.
 */
type Channel = (userId: number, jobId: number | null, message: string) => Promise<void>;

const inApp: Channel = async (userId, jobId, message) => {
  db.prepare("INSERT INTO notifications (user_id, job_id, message) VALUES (?, ?, ?)").run(userId, jobId, message);
};

const CHANNELS: Channel[] = [inApp];

export async function notify(userId: number, jobId: number | null, message: string) {
  await Promise.allSettled(CHANNELS.map((c) => c(userId, jobId, message)));
}

export function listNotifications(userId: number, limit = 30) {
  return db
    .prepare("SELECT id, job_id, message, read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(userId, limit);
}

export function unreadCount(userId: number): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0").get(userId) as {
    n: number;
  };
  return Number(row.n);
}

export function markAllRead(userId: number) {
  db.prepare("UPDATE notifications SET read = 1 WHERE user_id = ?").run(userId);
}
