export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string; reply_to_message?: { message_id: number } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
}
export interface TelegramApi {
  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, extra?: Record<string, unknown>): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, extra?: Record<string, unknown>): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
}

export function createTelegramApi(opts: {
  token: string; fetch: typeof fetch;
  /** Timeout por llamada (10 s); getUpdates espera su long-poll más longPollGraceMs (15 s). */
  timeoutMs?: number; longPollGraceMs?: number;
}): TelegramApi {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const graceMs = opts.longPollGraceMs ?? 15_000;
  // La URL lleva el token: ningún mensaje de error puede incluirlo.
  const fail = (method: string, reason: string) => new Error(`Telegram ${method}: ${reason.split(opts.token).join("[redactado]")}`);
  async function call<T>(method: string, body: Record<string, unknown>, ms = timeoutMs): Promise<T> {
    const signal = AbortSignal.timeout(ms);
    let data: { ok: boolean; result?: T; description?: string };
    let status: number;
    try {
      const response = await opts.fetch(`https://api.telegram.org/bot${opts.token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
      });
      status = response.status;
      data = (await response.json()) as typeof data;
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? `sin respuesta en ${ms / 1000} s`
        : error instanceof Error ? error.message : "error de red";
      throw fail(method, reason);
    }
    if (!data.ok) throw fail(method, String(data.description ?? status));
    return data.result as T;
  }
  return {
    getUpdates: (offset, timeoutSec) => call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, timeoutSec * 1000 + graceMs),
    sendMessage: (chatId, text, extra = {}) => call<{ message_id: number }>("sendMessage", { chat_id: chatId, text, ...extra }),
    editMessageText: async (chatId, messageId, text, extra = {}) => { await call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra }); },
    answerCallbackQuery: async (id, text) => { await call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }); },
  };
}
