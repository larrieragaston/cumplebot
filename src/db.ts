// Acceso a D1 (SQLite). El schema está en migrations/.
import { occursOn, type YMD } from "./dates";

export type Kind = "birthday" | "event";

export interface Event {
  id: number;
  chat_id: number;
  kind: Kind;
  name: string;
  day: number;
  month: number;
  year: number | null;
  greeting: string | null;
  phone: string | null;
}

export type NewEvent = Omit<Event, "id">;

export interface Conversation {
  chat_id: number;
  kind: Kind;
  step: "name" | "date" | "confirm";
  name: string | null;
  /** En step "confirm": la entrada pendiente, en JSON */
  payload: string | null;
}

const EVENT_COLS = "id, chat_id, kind, name, day, month, year, greeting, phone";
const INSERT_COLS = ["chat_id", "kind", "name", "day", "month", "year", "greeting", "phone"] as const;
// D1 acepta hasta 100 parámetros por consulta
const ROWS_PER_INSERT = Math.floor(100 / INSERT_COLS.length);

function isoDate(d: YMD): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** Inserta varios eventos con pocas consultas (el plan gratis de D1 limita las consultas por request). */
export async function addEvents(db: D1Database, events: NewEvent[]): Promise<Event[]> {
  const added: Event[] = [];
  for (let i = 0; i < events.length; i += ROWS_PER_INSERT) {
    const chunk = events.slice(i, i + ROWS_PER_INSERT);
    const placeholders = chunk.map(() => `(${INSERT_COLS.map(() => "?").join(", ")})`).join(", ");
    const { results } = await db
      .prepare(`INSERT INTO events (${INSERT_COLS.join(", ")}) VALUES ${placeholders} RETURNING ${EVENT_COLS}`)
      .bind(...chunk.flatMap((e) => INSERT_COLS.map((c) => e[c])))
      .all<Event>();
    added.push(...results);
  }
  return added;
}

/** Completa saludo y/o teléfono de eventos existentes (sin pisar con vacío). */
export async function updateExtras(db: D1Database, updates: { id: number; greeting: string | null; phone: string | null }[]): Promise<void> {
  if (!updates.length) return;
  await db.batch(
    updates.map((u) =>
      db.prepare("UPDATE events SET greeting = COALESCE(?, greeting), phone = COALESCE(?, phone) WHERE id = ?").bind(u.greeting, u.phone, u.id),
    ),
  );
}

/** Reemplaza nombre y fecha de un evento existente; saludo, teléfono y año solo si vienen. */
export async function replaceEvent(db: D1Database, chatId: number, id: number, e: NewEvent): Promise<Event | null> {
  return db
    .prepare(
      `UPDATE events SET name = ?, day = ?, month = ?, year = COALESCE(?, year), greeting = COALESCE(?, greeting), phone = COALESCE(?, phone)
       WHERE id = ? AND chat_id = ? RETURNING ${EVENT_COLS}`,
    )
    .bind(e.name, e.day, e.month, e.year, e.greeting, e.phone, id, chatId)
    .first<Event>();
}

export async function listEvents(db: D1Database, chatId: number): Promise<Event[]> {
  const { results } = await db.prepare(`SELECT ${EVENT_COLS} FROM events WHERE chat_id = ?`).bind(chatId).all<Event>();
  return results;
}

export async function deleteEvent(db: D1Database, chatId: number, id: number): Promise<Event | null> {
  return db
    .prepare(`DELETE FROM events WHERE id = ? AND chat_id = ? RETURNING ${EVENT_COLS}`)
    .bind(id, chatId)
    .first<Event>();
}

/** Eventos (de todos los chats) que ocurren en `d` y todavía no fueron avisados. */
export async function pendingFor(db: D1Database, d: YMD): Promise<Event[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.chat_id, e.kind, e.name, e.day, e.month, e.year, e.greeting, e.phone
       FROM events e
       LEFT JOIN notifications n ON n.event_id = e.id AND n.sent_on = ?
       WHERE e.month = ? AND n.event_id IS NULL`,
    )
    .bind(isoDate(d), d.month)
    .all<Event>();
  return results.filter((e) => occursOn(e.day, e.month, d));
}

export async function markNotified(db: D1Database, eventId: number, d: YMD): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO notifications (event_id, sent_on) VALUES (?, ?)").bind(eventId, isoDate(d)).run();
}

export async function getConversation(db: D1Database, chatId: number): Promise<Conversation | null> {
  return db
    .prepare("SELECT chat_id, kind, step, name, payload FROM conversations WHERE chat_id = ?")
    .bind(chatId)
    .first<Conversation>();
}

export async function saveConversation(db: D1Database, c: Conversation): Promise<void> {
  await db
    .prepare(
      `INSERT INTO conversations (chat_id, kind, step, name, payload) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET kind = excluded.kind, step = excluded.step, name = excluded.name,
         payload = excluded.payload, updated_at = datetime('now')`,
    )
    .bind(c.chat_id, c.kind, c.step, c.name, c.payload)
    .run();
}

export async function clearConversation(db: D1Database, chatId: number): Promise<void> {
  await db.prepare("DELETE FROM conversations WHERE chat_id = ?").bind(chatId).run();
}
