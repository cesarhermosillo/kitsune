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

export function createTelegramApi(opts: { token: string; fetch: typeof fetch }): TelegramApi {
  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await opts.fetch(`https://api.telegram.org/bot${opts.token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? response.status}`);
    return data.result as T;
  }
  return {
    getUpdates: (offset, timeoutSec) => call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }),
    sendMessage: (chatId, text, extra = {}) => call<{ message_id: number }>("sendMessage", { chat_id: chatId, text, ...extra }),
    editMessageText: async (chatId, messageId, text, extra = {}) => { await call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra }); },
    answerCallbackQuery: async (id, text) => { await call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }); },
  };
}
