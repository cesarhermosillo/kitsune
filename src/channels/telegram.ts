import type { InboxEvent, Proposal } from "../types.js";
import type { TelegramApi, TgUpdate } from "./telegram-api.js";

export type CallbackAction =
  | "approve" | "reject" | "edit" | "retry" | "edit_request" | "edit_repo" | "edit_workflow" | "set_repo" | "set_workflow"
  | "launch_with" | "other_workflows" | "cancel_launch";
export type ChannelEvent =
  | { type: "callback"; callbackId: string; chatId: number; messageId: number; action: CallbackAction; proposalId: string; index?: number }
  | { type: "message"; chatId: number; messageId: number; text: string; replyToMessageId?: number };
/** Una entrada del selector de workflow: la etiqueta a mostrar y su índice en `catalog.workflows`. */
export interface WorkflowOption { label: string; index: number }
export interface Channel {
  sendProposal(p: Proposal, event: InboxEvent | null): Promise<number>;
  updateProposal(p: Proposal, note: string): Promise<void>;
  sendEditMenu(p: Proposal): Promise<number>;
  askForRequest(p: Proposal): Promise<number>;
  sendChoices(p: Proposal, field: "repo" | "workflow", options: string[]): Promise<number>;
  /** Selector de workflow al lanzar: un botón `launch_with` por opción, más "Otro…"/"Cancelar" si se piden. */
  sendWorkflowChoice(p: Proposal, title: string, options: WorkflowOption[], extra: { other?: boolean; cancel?: boolean }): Promise<number>;
  /** Edita cualquier mensaje propio por su id, sin botones (usado para el selector tras lanzar). Best-effort en app.ts. */
  editRaw(messageId: number, text: string): Promise<void>;
  sendNotice(text: string): Promise<number>;
  sendQuestion(session: string, question: string, options?: string[]): Promise<number>;
  ackCallback(callbackId: string, text?: string): Promise<void>;
}

const CODES: Record<CallbackAction, string> = {
  approve: "a", reject: "r", edit: "e", retry: "t", edit_request: "er", edit_repo: "eo", edit_workflow: "ew", set_repo: "sr", set_workflow: "sw",
  launch_with: "lw", other_workflows: "ow", cancel_launch: "cx",
};
const ACTIONS = Object.fromEntries(Object.entries(CODES).map(([action, code]) => [code, action])) as Record<string, CallbackAction>;

export function encodeCallback(action: CallbackAction, proposalId: string, index?: number): string {
  return index === undefined ? `${CODES[action]}:${proposalId}` : `${CODES[action]}:${proposalId}:${index}`;
}

export function parseUpdate(update: TgUpdate): ChannelEvent | null {
  const cb = update.callback_query;
  if (cb) {
    const [code, proposalId, rawIndex] = (cb.data ?? "").split(":");
    const action = ACTIONS[code];
    if (!action || !proposalId || !cb.message) return null;
    const event: ChannelEvent = { type: "callback", callbackId: cb.id, chatId: cb.message.chat.id, messageId: cb.message.message_id, action, proposalId };
    if (rawIndex !== undefined && /^\d+$/.test(rawIndex)) event.index = Number(rawIndex);
    return event;
  }
  const msg = update.message;
  if (!msg || typeof msg.text !== "string") return null;
  const event: ChannelEvent = { type: "message", chatId: msg.chat.id, messageId: msg.message_id, text: msg.text };
  if (msg.reply_to_message) event.replyToMessageId = msg.reply_to_message.message_id;
  return event;
}

export function renderProposal(p: Proposal, event: InboxEvent | null): string {
  const header = event ? `${event.title}\n${event.url}` : p.title ? `${p.title}\n${p.url}` : p.origin;
  return [
    "🦊 Nueva tarea",
    header,
    "",
    `Repo: ${p.repo}`,
    `Workflow: ${p.workflowName}`,
    "",
    "Petición:",
    p.request,
  ].join("\n");
}

const MAX_TEXT = 4000; // Telegram acepta 4096 caracteres por mensaje.
/** Acota cualquier texto saliente a MAX_TEXT caracteres (incluida la "…"). */
export function fitText(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  let cut = text.slice(0, MAX_TEXT - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

type Button = { text: string; callback_data: string };
const keyboard = (rows: Button[][]) => ({ reply_markup: { inline_keyboard: rows } });

export function createTelegramChannel(opts: { api: TelegramApi; chatId: number }): Channel {
  const send = async (text: string, extra?: Record<string, unknown>) => (await opts.api.sendMessage(opts.chatId, fitText(text), extra)).message_id;
  return {
    sendProposal: (p, event) => send(renderProposal(p, event), keyboard([[
      { text: "✅ Lanzar", callback_data: encodeCallback("approve", p.id) },
      { text: "✏️ Editar", callback_data: encodeCallback("edit", p.id) },
      { text: "❌ Ignorar", callback_data: encodeCallback("reject", p.id) },
    ]])),
    async updateProposal(p, note) {
      if (p.telegramMessageId === null) { await send(note); return; }
      const rows = p.status === "failed" ? [[{ text: "🔁 Reintentar", callback_data: encodeCallback("retry", p.id) }]] : [];
      await opts.api.editMessageText(opts.chatId, p.telegramMessageId, fitText(`${renderProposal(p, null)}\n\n${note}`), keyboard(rows));
    },
    sendEditMenu: (p) => send("¿Qué quieres cambiar?", keyboard([[
      { text: "📝 Petición", callback_data: encodeCallback("edit_request", p.id) },
      { text: "📦 Repo", callback_data: encodeCallback("edit_repo", p.id) },
      { text: "🔀 Workflow", callback_data: encodeCallback("edit_workflow", p.id) },
    ]])),
    askForRequest: (p) => send(`Responde a este mensaje con la nueva petición.\n\nActual:\n${p.request}`, { reply_markup: { force_reply: true } }),
    sendChoices: (p, field, options) => send(field === "repo" ? "Elige el repo:" : "Elige el workflow:", keyboard(
      options.map((option, index) => [{ text: option, callback_data: encodeCallback(field === "repo" ? "set_repo" : "set_workflow", p.id, index) }]),
    )),
    sendWorkflowChoice: (p, title, options, extra) => {
      const rows: Button[][] = options.map((o) => [{ text: o.label, callback_data: encodeCallback("launch_with", p.id, o.index) }]);
      if (extra.other) rows.push([{ text: "Otro…", callback_data: encodeCallback("other_workflows", p.id) }]);
      if (extra.cancel) rows.push([{ text: "Cancelar", callback_data: encodeCallback("cancel_launch", p.id) }]);
      return send(title, keyboard(rows));
    },
    editRaw: async (messageId, text) => { await opts.api.editMessageText(opts.chatId, messageId, fitText(text), keyboard([])); },
    sendNotice: (text) => send(text),
    sendQuestion: (session, question, options) => {
      const base = `❓ La sesión ${session} pregunta:\n\n${question}`;
      const text = options && options.length > 0
        ? `${base}\n\n${options.map((label, i) => `${i + 1}. ${label}`).join("\n")}\n\nResponde con el número de la opción.`
        : `${base}\n\nResponde a este mensaje para contestarle.`;
      return send(text, { reply_markup: { force_reply: true } });
    },
    ackCallback: (callbackId, text) => opts.api.answerCallbackQuery(callbackId, text),
  };
}
