// Cliente mínimo de la Bot API de Telegram.

export interface TgUser {
  id: number;
  first_name: string;
}

export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  text?: string;
  document?: TgDocument;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }
  | { text: string; copy_text: { text: string } };

export interface SendOptions {
  buttons?: InlineButton[][];
  html?: boolean;
}

export const ALLOWED_UPDATES = ["message", "callback_query"];

const MAX_MESSAGE_LENGTH = 4000;

export async function callApi(token: string, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method} falló: ${data.description ?? res.status}`);
  return data.result;
}

/** Manda un mensaje, partiéndolo por líneas si supera el límite de Telegram. Los botones van en el último. */
export async function sendMessage(token: string, chatId: number, text: string, opts: SendOptions = {}): Promise<void> {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + line.length + 1 > MAX_MESSAGE_LENGTH) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  chunks.push(current);
  for (const [i, chunk] of chunks.entries()) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      ...(opts.html ? { parse_mode: "HTML" } : {}),
      ...(opts.buttons && i === chunks.length - 1 ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
    });
  }
}

export function editMessageText(token: string, chatId: number, messageId: number, text: string): Promise<unknown> {
  return callApi(token, "editMessageText", { chat_id: chatId, message_id: messageId, text });
}

export function answerCallbackQuery(token: string, id: string, text?: string): Promise<unknown> {
  return callApi(token, "answerCallbackQuery", { callback_query_id: id, text });
}

/** Descarga un archivo que el usuario le mandó al bot. */
export async function downloadFile(token: string, fileId: string): Promise<string> {
  const file = (await callApi(token, "getFile", { file_id: fileId })) as { file_path: string };
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`No pude descargar el archivo: ${res.status}`);
  return res.text();
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
