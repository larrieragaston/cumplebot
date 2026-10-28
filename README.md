# cumplebot

Bot de Telegram que te avisa los cumpleaños y fechas importantes. Corre en Cloudflare Workers (gratis):

- **Worker**: recibe los mensajes de Telegram por webhook (`/webhook`).
- **D1** (SQLite): guarda cumpleaños, eventos y avisos enviados (schema en `migrations/`).
- **Cron Trigger**: corre cada hora y, a partir de `REMINDER_HOUR` (hora local), manda los avisos del día. Si una corrida falla, la siguiente reintenta sin duplicar.

## Uso

Para agregar, se manda nombre y fecha en texto libre, sin comando. Se pueden mandar varios, uno por línea:

```
Juan Pérez 15/03
Ana 2 de mayo de 1990
cumple de Caro el 7/11
```

El año es opcional (si está, el aviso dice cuántos cumple). Fechas aceptadas: `15/03`, `15-3-90`, `15.03.1990`, `15 de marzo`, `1ro de dic`...

Los comandos funcionan con o sin `/`, sin importar mayúsculas ni acentos:

| Comando (alias) | Qué hace |
|---|---|
| `cumple` (`agregar`) | Carga guiada: pregunta nombre y fecha |
| `lista` (`todos`) | Todo lo cargado, ordenado por cercanía |
| `proximos` | Los próximos 30 días |
| `borrar Juan` / `borrar 3` (`eliminar`, `sacar`) | Borra por nombre o id; si hay varios que coinciden, muestra botones |
| `cancelar` | Cancela una carga a medias |
| `ayuda` | Ayuda |

Si cargás a alguien con un nombre parecido a uno existente ("Juan" y "Juan Pérez"), el bot pregunta con botones si agregarlo como nuevo, actualizar el existente o cancelar. En cargas masivas lo avisa en el resumen.

Los eventos generales (`kind = 'event'` en la base) están soportados en el modelo pero deshabilitados en el bot por ahora.

## Saludo sugerido

Cada cumpleaños puede tener opcionalmente el **teléfono** y un **saludo sugerido**, separados con `|`:

```
Juan Pérez 15/03 | +5491122334455 | ¡Feliz cumple crack! Que la pases genial
```

El aviso muestra ese saludo, un botón **📋 Copiar saludo** y, si hay teléfono, **💬 Saludar por WhatsApp**, que abre el chat con el texto ya escrito.
Si cargás de nuevo a alguien que ya existe pero con saludo o teléfono, se completa (no se duplica).

## Carga inicial desde WhatsApp (iPhone)

`scripts/whatsapp_cumples.py` busca en un backup local del iPhone los "feliz cumple", "hbd", "que los cumplas", etc. que mandaste vos y arma `cumples-whatsapp.txt` (ignorado por git), con nombre, fecha, teléfono y tu último saludo a cada persona.

1. Conectá el iPhone a la Mac → Finder → tu iPhone → General → "Hacer un backup de todos los datos del iPhone en esta Mac", con **"Encriptar backup local" tildado** → "Hacer backup ahora".
2. Finder → "Administrar backups" → clic derecho en el backup → "Mostrar en Finder" → **copiá la carpeta** (por ej. al Escritorio). Así la terminal no necesita acceso total al disco.
3. `npm run whatsapp -- --backup ~/Desktop/<carpeta-copiada>`. Pide la contraseña del backup y desencripta **solo** la base de WhatsApp en una carpeta temporal que se borra al terminar (usa [`iphone_backup_decrypt`](https://github.com/jsharkey13/iphone_backup_decrypt), instalada en `.venv/`).
4. Revisá el `.txt` y **mandáselo como archivo al bot**. Lo que va después de `#` el bot lo ignora.
   El script también genera `estilo-whatsapp.txt` con ejemplos de cómo escribís (tus saludos y tus últimos mensajes a cada persona), útil para redactar saludos sugeridos con tu estilo. Ninguno de los dos archivos se sube a git.
5. Borrá la copia del backup.

## Probar en local

1. Creá un bot de prueba con [@BotFather](https://t.me/BotFather) (`/newbot`) y copiá el token.
2. `cp .dev.vars.example .dev.vars` y completá `TELEGRAM_BOT_TOKEN` y `WEBHOOK_SECRET` (cualquier string).
3. `npm install`
4. `npm run db:migrate:local` (crea/actualiza las tablas en la D1 local)
5. En una terminal: `npm run dev` (Worker local en `http://localhost:8787`)
6. En otra terminal: `npm run poll` (trae los mensajes de Telegram y se los pasa al Worker local)
7. Hablale al bot desde Telegram.
8. Para simular el aviso diario: `curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"`
   (solo avisa si la hora local es >= `REMINDER_HOUR`; para probar a cualquier hora, poné `REMINDER_HOUR = "0"` en `wrangler.toml`)

Ver la base local: `npx wrangler d1 execute cumplebot --local --command "SELECT * FROM events"`

## Deploy a Cloudflare

1. `npx wrangler login`
2. `npx wrangler d1 create cumplebot` y pegá el `database_id` que imprime en `wrangler.toml`
3. `npm run db:migrate` (crea/actualiza las tablas en la D1 remota)
4. `npx wrangler secret put TELEGRAM_BOT_TOKEN`, `npx wrangler secret put WEBHOOK_SECRET` y `npx wrangler secret put ALLOWED_USER_IDS` (tu ID de Telegram; separados por coma si son varios)
5. `npm run deploy` (imprime la URL, tipo `https://cumplebot.<tu-subdominio>.workers.dev`)
6. Abrí `https://cumplebot.<tu-subdominio>.workers.dev/setup?key=<WEBHOOK_SECRET>` una vez para registrar el webhook y los comandos.
7. Si no sabés tu ID de Telegram: cargá cualquier número en `ALLOWED_USER_IDS`, mandale un mensaje al bot y te responde con tu ID. Actualizá el secreto con ese valor.

> Si después de deployar querés volver a probar en local con `npm run poll`, el script borra el webhook; al terminar, volvé a abrir `/setup`.

## Desarrollo

- `npm test`: tests unitarios (fechas, parseo, formato)
- `npm run typecheck`
