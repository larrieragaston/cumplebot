// Entry point del Worker: webhook de Telegram, setup y cron.
import { COMMANDS, handleUpdate, sendReminders, type Env } from "./bot";
import { ALLOWED_UPDATES, callApi, type TgUpdate } from "./telegram";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const update = (await request.json()) as TgUpdate;
      try {
        await handleUpdate(update, env);
      } catch (err) {
        // Respondemos 200 igual para que Telegram no reintente el mismo update en loop
        console.error("Error procesando update", update.update_id, err);
      }
      return new Response("ok");
    }

    // Registra el webhook y los comandos del bot. Visitar una vez después de deployar.
    if (url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      await callApi(env.TELEGRAM_BOT_TOKEN, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ALLOWED_UPDATES,
      });
      await callApi(env.TELEGRAM_BOT_TOKEN, "setMyCommands", { commands: COMMANDS });
      return new Response(`Webhook configurado en ${url.origin}/webhook`);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendReminders(env));
  },
} satisfies ExportedHandler<Env>;
