// Lógica del bot: comandos, carga libre/guiada, borrado y avisos diarios.
import { daysBetween, extractEntry, findDate, fold, formatDate, nextOccurrence, nowIn, type ParsedDate, type YMD } from "./dates";
import * as db from "./db";
import type { Event, Kind } from "./db";
import {
  answerCallbackQuery,
  downloadFile,
  editMessageText,
  escapeHtml,
  sendMessage,
  type InlineButton,
  type SendOptions,
  type TgCallbackQuery,
  type TgMessage,
  type TgUpdate,
} from "./telegram";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  TIMEZONE: string;
  REMINDER_HOUR: string;
  ALLOWED_USER_IDS?: string;
}

type Reply = (text: string, opts?: SendOptions) => Promise<void>;

export interface Entry {
  name: string;
  date: ParsedDate;
  phone: string | null;
  greeting: string | null;
}

// Más de esto en una carga y solo mostramos el resumen
const MAX_LISTED_ON_ADD = 10;
const MAX_IMPORT_FILE_BYTES = 1_000_000;
type Command = "add" | "list" | "upcoming" | "delete" | "cancel" | "help" | "event" | "unknown";

const ICONS: Record<Kind, string> = { birthday: "🎂", event: "📅" };

// Alias aceptados (sin acentos, en minúscula), con o sin "/"
const ALIASES: Record<string, Command> = {
  cumple: "add", cumples: "add", cumpleanos: "add", agregar: "add", agrega: "add", nuevo: "add", add: "add",
  lista: "list", listar: "list", todos: "list", list: "list",
  proximos: "upcoming", proximo: "upcoming", next: "upcoming",
  borrar: "delete", borra: "delete", eliminar: "delete", elimina: "delete", quitar: "delete", sacar: "delete", delete: "delete",
  cancelar: "cancel", cancel: "cancel",
  start: "help", ayuda: "help", help: "help", hola: "help",
  evento: "event", eventos: "event",
};

export const COMMANDS = [
  { command: "cumple", description: "Agregar un cumpleaños" },
  { command: "lista", description: "Ver todos los cumpleaños" },
  { command: "proximos", description: "Los próximos 30 días" },
  { command: "borrar", description: "Borrar por nombre o id" },
  { command: "cancelar", description: "Cancelar la carga en curso" },
  { command: "ayuda", description: "Cómo usar el bot" },
];

function helpText(env: Env): string {
  return (
    "¡Hola! Te aviso de los cumpleaños para que no te olvides de saludar 🎉\n\n" +
    "Para agregar, mandame nombre y fecha como te salga:\n" +
    "• Juan Pérez 15/03\n" +
    "• Ana 2 de mayo de 1990\n" +
    "• cumple de Caro el 7/11\n" +
    "El año es opcional. Podés mandar varios juntos, uno por línea, o un archivo .txt.\n" +
    "Opcional, separado con |: el saludo y su WhatsApp, ej: Juan 15/03 | +5491122334455 | ¡Feliz cumple crack!\n\n" +
    "lista — ver todos\n" +
    "proximos — los próximos 30 días\n" +
    "borrar Juan — borrar (por nombre o por id)\n" +
    "cancelar — cancelar una carga a medias\n\n" +
    `Te aviso todos los días a las ${env.REMINDER_HOUR.padStart(2, "0")}:00.`
  );
}

function today(env: Env): YMD {
  const { year, month, day } = nowIn(env.TIMEZONE);
  return { year, month, day };
}

/** Línea para listados: icono, id, nombre, fecha, cuántos cumple y en cuántos días. */
export function describe(e: Event, ref: YMD): string {
  const next = nextOccurrence(e.day, e.month, ref);
  const days = daysBetween(ref, next);
  const when = days === 0 ? "¡hoy!" : days === 1 ? "mañana" : `en ${days} días`;
  let extra = "";
  if (e.year) {
    const n = next.year - e.year;
    extra = e.kind === "birthday" ? ` (cumple ${n})` : ` (${n} años)`;
  }
  return `${ICONS[e.kind]} #${e.id} ${e.name} — ${formatDate(e.day, e.month)}${extra} — ${when}`;
}

/** Aviso del día (HTML), con el último saludo y botones para copiarlo o abrir WhatsApp con el texto ya escrito. */
export function reminderMessage(e: Event, d: YMD): { text: string; buttons: InlineButton[][] } {
  const name = escapeHtml(e.name);
  if (e.kind === "event") {
    const years = e.year ? ` (${d.year - e.year} años)` : "";
    return { text: `📅 Hoy: ${name}${years}`, buttons: [] };
  }
  const age = e.year ? ` Cumple ${d.year - e.year} 🥳` : "";
  let text = `🎂 ¡Hoy es el cumpleaños de <b>${name}</b>!${age}\n`;
  text += e.greeting
    ? `\nSaludo sugerido:\n<blockquote>${escapeHtml(e.greeting)}</blockquote>`
    : "No te olvides de saludar 😉";

  const buttons: InlineButton[][] = [];
  if (e.phone) {
    const message = e.greeting ?? "¡Feliz cumple! 🎉";
    buttons.push([{ text: "💬 Saludar por WhatsApp", url: `https://wa.me/${e.phone}?text=${encodeURIComponent(message)}` }]);
  }
  if (e.greeting) buttons.push([{ text: "📋 Copiar saludo", copy_text: { text: e.greeting.slice(0, 256) } }]);
  return { text, buttons };
}

/** Una línea de carga: "nombre fecha [| teléfono] [| saludo]". */
export function parseLine(line: string, currentYear: number): Entry | { error: string } {
  const [main, ...extras] = line.split("|").map((s) => s.trim());
  const entry = extractEntry(main, currentYear);
  if ("error" in entry) return entry;
  let phone: string | null = null;
  let greeting: string | null = null;
  for (const extra of extras.filter(Boolean)) {
    if (/^\+?[\d\s\-()]{8,}$/.test(extra)) phone = extra.replace(/\D/g, "");
    else greeting = extra;
  }
  return { ...entry, phone, greeting };
}

/**
 * Detecta un comando. Con "/" siempre es comando ('/cumple@MiBot Juan 15/03').
 * Sin "/" solo si la primera palabra es un alias y no es de alta ('lista', 'borrar Juan'):
 * el texto libre con fecha ya se interpreta como alta.
 */
export function parseCommand(text: string): { command: Command; rest: string } | null {
  const m = /^(\/)?([^\s@]+)(?:@\S+)?\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const command = ALIASES[fold(m[2])];
  if (m[1]) return { command: command ?? "unknown", rest: m[3].trim() };
  if (command && command !== "add") return { command, rest: m[3].trim() };
  return null;
}

function sortByNext(events: Event[], ref: YMD): Event[] {
  return events
    .map((e) => ({ e, days: daysBetween(ref, nextOccurrence(e.day, e.month, ref)) }))
    .sort((a, b) => a.days - b.days)
    .map(({ e }) => e);
}

/** Busca por nombre sin importar mayúsculas ni acentos; si hay coincidencia exacta, gana esa. */
export function matchByName(events: Event[], query: string): Event[] {
  const q = fold(query).trim();
  const exact = events.filter((e) => fold(e.name) === q);
  if (exact.length) return exact;
  return events.filter((e) => fold(e.name).includes(q));
}

/** ¿Dos nombres pueden ser la misma persona? "Juan" ~ "Juan Pérez", "Sofi Gómez" ~ "Sofi Ramírez". */
export function isSimilarName(a: string, b: string): boolean {
  const wa = fold(a).trim().split(/\s+/);
  const wb = fold(b).trim().split(/\s+/);
  if (wa[0].length >= 3 && wa[0] === wb[0]) return true;
  // Todas las palabras del nombre más corto están en el otro: "Pérez" ~ "Juan Pérez"
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every((w) => long.includes(w));
}

function isAllowed(env: Env, userId: number): boolean {
  const allowed = (env.ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return !allowed.length || allowed.includes(String(userId));
}

export async function handleUpdate(update: TgUpdate, env: Env): Promise<void> {
  if (update.callback_query) return handleCallback(update.callback_query, env);

  const msg = update.message;
  if (!msg?.from || (!msg.text && !msg.document)) return;

  const reply: Reply = (text, opts) => sendMessage(env.TELEGRAM_BOT_TOKEN, msg.chat.id, text, opts);

  if (!isAllowed(env, msg.from.id)) {
    await reply(`Este bot es privado. Tu ID de Telegram es ${msg.from.id}`);
    return;
  }

  if (msg.document) return importFile(msg, env, reply);

  const cmd = parseCommand(msg.text!);
  if (!cmd) return handleText(msg, env, reply);

  // Cualquier comando corta una carga guiada que haya quedado a medias
  await db.clearConversation(env.DB, msg.chat.id);

  switch (cmd.command) {
    case "help":
      return reply(helpText(env));
    case "add":
      if (!cmd.rest) {
        await db.saveConversation(env.DB, { chat_id: msg.chat.id, kind: "birthday", step: "name", name: null, payload: null });
        return reply("¿De quién es el cumpleaños? (podés mandar nombre y fecha juntos)");
      }
      return addLines(msg, env, cmd.rest, reply);
    case "list": {
      const ref = today(env);
      const events = sortByNext(await db.listEvents(env.DB, msg.chat.id), ref);
      if (!events.length) return reply("No hay nada cargado todavía. Mandame un nombre y una fecha, ej: Juan 15/03");
      return reply(`${events.length} cumpleaños:\n\n${events.map((e) => describe(e, ref)).join("\n")}`);
    }
    case "upcoming": {
      const ref = today(env);
      const events = sortByNext(await db.listEvents(env.DB, msg.chat.id), ref).filter(
        (e) => daysBetween(ref, nextOccurrence(e.day, e.month, ref)) <= 30,
      );
      return reply(events.length ? events.map((e) => describe(e, ref)).join("\n") : "Nada en los próximos 30 días 😌");
    }
    case "delete":
      return deleteCmd(msg, env, cmd.rest, reply);
    case "cancel":
      return reply("Cancelado.");
    case "event":
      return reply("Los eventos todavía no están habilitados. Por ahora solo cumpleaños 🎂");
    default:
      return reply("No conozco ese comando. Mandá ayuda para ver qué puedo hacer.");
  }
}

async function deleteCmd(msg: TgMessage, env: Env, query: string, reply: Reply): Promise<void> {
  if (!query) return reply("¿Qué querés borrar? Ej: borrar Juan (o el número que ves en la lista)");

  const id = /^#?(\d+)$/.exec(query);
  if (id) {
    const deleted = await db.deleteEvent(env.DB, msg.chat.id, Number(id[1]));
    return reply(deleted ? `Borrado: ${deleted.name} (${formatDate(deleted.day, deleted.month)})` : "No encontré ese número 🤔");
  }

  const matches = matchByName(await db.listEvents(env.DB, msg.chat.id), query);
  if (!matches.length) return reply(`No encontré a nadie que se llame "${query}" 🤔`);
  if (matches.length === 1) {
    const [e] = matches;
    await db.deleteEvent(env.DB, msg.chat.id, e.id);
    return reply(`Borrado: ${e.name} (${formatDate(e.day, e.month)})`);
  }
  const buttons = matches.slice(0, 20).map((e) => [{ text: `${e.name} — ${formatDate(e.day, e.month)}`, callback_data: `del:${e.id}` }]);
  return reply(`Encontré ${matches.length}. ¿Cuál borro?`, { buttons });
}

/** Carga masiva desde un .txt (ej. el que genera scripts/whatsapp_cumples.py), una persona por línea. */
async function importFile(msg: TgMessage, env: Env, reply: Reply): Promise<void> {
  const doc = msg.document!;
  const isText = doc.mime_type?.startsWith("text/") || /\.(txt|csv)$/i.test(doc.file_name ?? "");
  if (!isText) return reply("Mandame un archivo .txt con una persona por línea (ej: Juan 15/03).");
  if ((doc.file_size ?? 0) > MAX_IMPORT_FILE_BYTES) return reply("El archivo es muy grande (máximo 1 MB).");
  const text = await downloadFile(env.TELEGRAM_BOT_TOKEN, doc.file_id);
  return addLines(msg, env, text, reply);
}

async function handleCallback(cb: TgCallbackQuery, env: Env): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!isAllowed(env, cb.from.id) || !cb.message) {
    await answerCallbackQuery(token, cb.id);
    return;
  }
  const chatId = cb.message.chat.id;
  const edit = (text: string) => editMessageText(token, chatId, cb.message!.message_id, text);
  const data = cb.data ?? "";

  const del = /^del:(\d+)$/.exec(data);
  if (del) {
    const deleted = await db.deleteEvent(env.DB, chatId, Number(del[1]));
    await answerCallbackQuery(token, cb.id, deleted ? "Borrado" : undefined);
    await edit(deleted ? `Borrado: ${deleted.name} (${formatDate(deleted.day, deleted.month)})` : "Ya no existe esa entrada.");
    return;
  }

  // Respuesta a "ya tenés algo parecido": add:new, add:upd:<id> o add:no
  const add = /^add:(new|no|upd:(\d+))$/.exec(data);
  await answerCallbackQuery(token, cb.id);
  if (!add) return;
  const conv = await db.getConversation(env.DB, chatId);
  if (conv?.step !== "confirm" || !conv.payload) {
    await edit("Esa carga ya no está pendiente.");
    return;
  }
  await db.clearConversation(env.DB, chatId);
  const entry = JSON.parse(conv.payload) as Entry;
  const newEvent: db.NewEvent = { chat_id: chatId, kind: "birthday", name: entry.name, ...entry.date, phone: entry.phone, greeting: entry.greeting };
  const ref = today(env);
  if (add[1] === "no") {
    await edit("Cancelado, no cargué nada.");
  } else if (add[1] === "new") {
    const [e] = await db.addEvents(env.DB, [newEvent]);
    await edit(`Listo ✅\n${describe(e, ref)}`);
  } else {
    const e = await db.replaceEvent(env.DB, chatId, Number(add[2]), newEvent);
    await edit(e ? `Actualizado ✅\n${describe(e, ref)}` : "Ya no existe esa entrada.");
  }
}

/** Texto libre: continúa una carga guiada o interpreta cada línea como "nombre + fecha". */
async function handleText(msg: TgMessage, env: Env, reply: Reply): Promise<void> {
  const text = msg.text!.trim();
  let conv = await db.getConversation(env.DB, msg.chat.id);
  if (conv?.step === "confirm") {
    // Escribió otra cosa en vez de tocar un botón: descartamos la carga pendiente
    await db.clearConversation(env.DB, msg.chat.id);
    conv = null;
  }

  if (conv?.step === "date") {
    const found = findDate(text, today(env).year);
    if (!found || found.error) {
      return reply(`No entendí la fecha${found?.error ? `: ${found.error}` : ""}. Probá con 15/03, 15/03/1990 o 15 de marzo`);
    }
    await db.clearConversation(env.DB, msg.chat.id);
    return addEntries(msg, env, [{ name: conv.name!, date: found.date!, phone: null, greeting: null }], [], reply);
  }

  if (conv?.step === "name") {
    const entry = parseLine(text, today(env).year);
    if ("name" in entry) {
      await db.clearConversation(env.DB, msg.chat.id);
      return addEntries(msg, env, [entry], [], reply);
    }
    await db.saveConversation(env.DB, { ...conv, step: "date", name: text });
    return reply(`¿Qué día es el cumple de ${text}? (ej: 15/03 o 15 de marzo, el año es opcional)`);
  }

  return addLines(msg, env, text, reply);
}

/** Alta de una o varias líneas "nombre + fecha". */
async function addLines(msg: TgMessage, env: Env, text: string, reply: Reply): Promise<void> {
  const year = today(env).year;
  // Lo que va después de "#" es un comentario (ej. el contexto que agrega scripts/whatsapp_cumples.py)
  const lines = text
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "").trim())
    .filter(Boolean);
  if (!lines.length) return;
  const parsed = lines.map((line) => ({ line, result: parseLine(line, year) }));
  const ok = parsed.flatMap((p) => ("name" in p.result ? [p.result] : []));
  const failed = parsed.flatMap((p) => ("error" in p.result ? [`• ${p.line} (${p.result.error})`] : []));

  if (!ok.length) {
    const hint = "Para agregar un cumple mandame nombre y fecha, ej: Juan 15/03. Mandá ayuda para ver más.";
    return reply(lines.length === 1 ? `No entendí 🤔 ${hint}` : `No entendí ninguna línea:\n${failed.join("\n")}\n\n${hint}`);
  }
  return addEntries(msg, env, ok, failed, reply);
}

async function addEntries(
  msg: TgMessage,
  env: Env,
  entries: Entry[],
  failed: string[],
  reply: Reply,
): Promise<void> {
  const ref = today(env);
  const existing = await db.listEvents(env.DB, msg.chat.id);
  const toAdd: db.NewEvent[] = [];
  const toUpdate: { id: number; greeting: string | null; phone: string | null }[] = [];
  const duplicated: string[] = [];
  const sameAs = (a: { name: string; day: number; month: number }, name: string, date: ParsedDate) =>
    fold(a.name) === fold(name) && a.day === date.day && a.month === date.month;

  // Alta de una sola persona con un nombre parecido a otro ya cargado: preguntamos antes de guardar
  if (entries.length === 1) {
    const [entry] = entries;
    const similar = existing.filter((e) => isSimilarName(e.name, entry.name) && !sameAs(e, entry.name, entry.date)).slice(0, 3);
    if (similar.length) {
      await db.saveConversation(env.DB, { chat_id: msg.chat.id, kind: "birthday", step: "confirm", name: entry.name, payload: JSON.stringify(entry) });
      const buttons: InlineButton[][] = [
        [{ text: `➕ Agregar ${entry.name} como nuevo`, callback_data: "add:new" }],
        ...similar.map((e) => [{ text: `✏️ Actualizar ${e.name} (${formatDate(e.day, e.month)})`, callback_data: `add:upd:${e.id}` }]),
        [{ text: "✖️ Cancelar", callback_data: "add:no" }],
      ];
      return reply(
        `Ya tenés algo parecido:\n${similar.map((e) => describe(e, ref)).join("\n")}\n\n¿Qué hago con ${entry.name} ${formatDate(entry.date.day, entry.date.month)}?`,
        { buttons },
      );
    }
  }

  const similarWarnings: string[] = [];
  for (const { name, date, phone, greeting } of entries) {
    const dup = existing.find((e) => sameAs(e, name, date));
    if (dup) {
      // Si ya existía pero ahora viene con saludo o teléfono, lo completamos
      if ((greeting && greeting !== dup.greeting) || (phone && phone !== dup.phone)) {
        toUpdate.push({ id: dup.id, greeting, phone });
      } else {
        duplicated.push(`• ${dup.name} (${formatDate(dup.day, dup.month)})`);
      }
      continue;
    }
    if (toAdd.some((e) => sameAs(e, name, date))) continue;
    const similar = existing.find((e) => isSimilarName(e.name, name));
    if (similar) similarWarnings.push(`• ${name} (${formatDate(date.day, date.month)}) ~ ${similar.name} (${formatDate(similar.day, similar.month)})`);
    toAdd.push({ chat_id: msg.chat.id, kind: "birthday", name, ...date, phone, greeting });
  }

  const added = await db.addEvents(env.DB, toAdd);
  await db.updateExtras(env.DB, toUpdate);

  const parts: string[] = [];
  if (added.length === 1) parts.push(`Listo ✅\n${describe(added[0], ref)}`);
  else if (added.length > MAX_LISTED_ON_ADD) parts.push(`Agregué ${added.length} ✅ Mandá lista para verlos.`);
  else if (added.length > 1) parts.push(`Agregué ${added.length} ✅\n${added.map((e) => describe(e, ref)).join("\n")}`);
  if (toUpdate.length) parts.push(`Actualicé el saludo/teléfono de ${toUpdate.length} que ya estaban.`);
  if (duplicated.length > MAX_LISTED_ON_ADD) parts.push(`${duplicated.length} ya estaban cargados.`);
  else if (duplicated.length) parts.push(`Ya estaban cargados:\n${duplicated.join("\n")}`);
  if (similarWarnings.length) parts.push(`Ojo, estos se parecen a otros que ya tenías (revisá con lista o borrar):\n${similarWarnings.join("\n")}`);
  if (failed.length) parts.push(`No entendí estas líneas:\n${failed.join("\n")}`);
  return reply(parts.join("\n\n"));
}

/** Corre en cada disparo del cron: a partir de REMINDER_HOUR manda los avisos pendientes del día. */
export async function sendReminders(env: Env): Promise<void> {
  const now = nowIn(env.TIMEZONE);
  if (now.hour < Number(env.REMINDER_HOUR)) return;
  const d: YMD = { year: now.year, month: now.month, day: now.day };
  for (const e of await db.pendingFor(env.DB, d)) {
    try {
      const { text, buttons } = reminderMessage(e, d);
      await sendMessage(env.TELEGRAM_BOT_TOKEN, e.chat_id, text, { html: true, buttons });
      await db.markNotified(env.DB, e.id, d);
    } catch (err) {
      console.error(`No pude avisar el evento ${e.id} al chat ${e.chat_id}`, err);
    }
  }
}
