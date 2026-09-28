# Crear el bot de Telegram

1. En Telegram, abre **@BotFather** y envía `/newbot`. Elige nombre y usuario.
2. Copia el token que te da y ponlo en `~/.kitsune/.env` como `TELEGRAM_BOT_TOKEN=…`.
3. Abre un chat **privado** con tu bot (no un grupo) y envíale cualquier mensaje.
4. Obtén tu `chatId` sin dejar el token en el historial del shell:
   ```sh
   read -s TOKEN   # pega el token y pulsa Enter; no se muestra ni queda en el historial
   curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates" | grep -o '"chat":{"id":[0-9]*'
   unset TOKEN
   ```
   En un chat privado el id es un número positivo (el de un grupo empieza con `-`).
5. Pon ese número en `~/.kitsune/config.json` → `telegram.chatId`.
6. `chmod 600 ~/.kitsune/.env`

Kitsune solo responde a ese `chatId`. Cualquier otro chat se ignora y queda en la auditoría.

**Usa siempre un chat privado con el bot.** Si `chatId` fuera un grupo, cualquier miembro del
grupo podría aprobar (✅) propuestas y lanzar sesiones.
