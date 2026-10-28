// Solo para desarrollo local: trae los mensajes de Telegram por long polling
// y se los reenvía al Worker que corre con `npm run dev`, como si fuera el webhook.
import { existsSync, readFileSync } from "node:fs";

const DEV_VARS = new URL("../.dev.vars", import.meta.url);
if (!existsSync(DEV_VARS)) {
  console.error("Falta el archivo .dev.vars. Creálo con: cp .dev.vars.example .dev.vars y completá el token.");
  process.exit(1);
}

const vars = Object.fromEntries(
  readFileSync(DEV_VARS, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const TOKEN = vars.TELEGRAM_BOT_TOKEN;
const SECRET = vars.WEBHOOK_SECRET;
const WORKER = process.env.WORKER_URL ?? "http://localhost:8787";

if (!/^\d+:[\w-]+$/.test(TOKEN ?? "")) {
  console.error("TELEGRAM_BOT_TOKEN en .dev.vars no parece un token válido (formato 123456789:ABC...). Pegá el que te dio @BotFather.");
  process.exit(1);
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

// getUpdates no funciona si hay un webhook configurado
await tg("deleteWebhook", {});
console.log(`Escuchando mensajes y reenviando a ${WORKER}/webhook (Ctrl+C para salir)`);

let offset = 0;
for (;;) {
  try {
    const updates = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
    for (const u of updates) {
      offset = u.update_id + 1;
      console.log(`→ ${u.message?.text ?? (u.callback_query ? `[botón] ${u.callback_query.data}` : "(sin texto)")}`);
      await fetch(`${WORKER}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
        body: JSON.stringify(u),
      });
    }
  } catch (err) {
    console.error(err.message);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
