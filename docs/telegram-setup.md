# Crear el bot de Telegram

1. En Telegram, abre **@BotFather** y envía `/newbot`. Elige nombre y usuario.
2. Copia el token que te da y ponlo en `~/.kitsune/.env` como `TELEGRAM_BOT_TOKEN=…`.
3. Abre un chat con tu bot y envíale cualquier mensaje.
4. Obtén tu `chatId`:
   `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9]*'`
5. Pon ese número en `~/.kitsune/config.json` → `telegram.chatId`.
6. `chmod 600 ~/.kitsune/.env`

Kitsune solo responde a ese `chatId`. Cualquier otro chat se ignora y queda en la auditoría.
