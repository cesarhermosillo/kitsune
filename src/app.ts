import { capRequest, TriageError, type Brain } from "./brain.js";
import { parseUpdate, type Channel, type ChannelEvent } from "./channels/telegram.js";
import type { TgUpdate } from "./channels/telegram-api.js";
import type { Policy } from "./policy.js";
import { InvalidTransition } from "./proposals.js";
import { RoninError, type RoninClient } from "./ronin-client.js";
import type { Store } from "./store.js";
import type { Catalog, InboxEvent, Proposal, Triage } from "./types.js";

export interface AppDeps {
  store: Store; brain: Brain; ronin: RoninClient; channel: Channel; policy: Policy; now: () => number; ttlMs: number;
  log?: (line: string) => void;
}
export interface KitsuneApp {
  onInboxEvent(event: InboxEvent): Promise<void>;
  onChannelEvent(event: ChannelEvent): Promise<void>;
  sweepExpired(): Promise<number>;
  /** Al arrancar: las propuestas que quedaron en `approved` (el daemon murió a medio lanzar) pasan a `failed`. */
  recoverInterrupted(): Promise<number>;
  /** Reenvía las propuestas pendientes cuyo envío a Telegram falló (sin message id). Devuelve cuántas se entregaron. */
  redeliver(): Promise<number>;
}

const clip = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max)}…` : text);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const MAX_SESSION_NAME = 60;
const SLUG_WORDS = 6;

/**
 * Nombre de sesión determinista y único por propuesta: `cowork-<slug>-<6 del id>`.
 * Cumple el contrato de Ronin (prefijo cowork-, [A-Za-z0-9._@-], ≤ 80) con ≤ 60 en total,
 * y es el mismo en cada reintento.
 */
export function sessionNameFor(p: Pick<Proposal, "id" | "request">): string {
  const suffix = p.id.slice(0, 6);
  const room = MAX_SESSION_NAME - "cowork-".length - 1 - suffix.length;
  const words = p.request.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean).slice(0, SLUG_WORDS);
  const slug = words.join("-").slice(0, room).replace(/-+$/, "") || "tarea";
  return `cowork-${slug}-${suffix}`;
}

/**
 * Procesa un lote de getUpdates. Cada update se maneja por separado y el offset
 * SIEMPRE avanza, falle o no: las acciones del usuario son a lo más una vez
 * (un update envenenado no puede bloquear el canal para siempre).
 */
export async function processUpdates(
  updates: TgUpdate[],
  deps: { app: KitsuneApp; store: Store; log: (line: string) => void; now: () => number },
): Promise<void> {
  for (const update of updates) {
    try {
      const event = parseUpdate(update);
      if (event) await deps.app.onChannelEvent(event);
    } catch (error) {
      deps.log(`[telegram] update ${update.update_id} falló: ${errorText(error)}`);
      deps.store.audit("kitsune", "update_failed", String(update.update_id), { error: errorText(error) }, deps.now());
    }
    deps.store.setCursor("telegram", String(update.update_id + 1));
  }
}

export function createKitsuneApp(deps: AppDeps): KitsuneApp {
  const { store, channel } = deps;
  const log = deps.log ?? (() => {});

  // Telegram es best-effort dentro de los flujos: un fallo al avisar o editar
  // (p. ej. "message is not modified" o "query is too old") nunca cambia el
  // estado de una propuesta ni escapa del handler.
  async function ack(callbackId: string, text?: string): Promise<void> {
    try { await channel.ackCallback(callbackId, text); } catch (error) { log(`[telegram] ack falló: ${errorText(error)}`); }
  }
  async function edit(p: Proposal, note: string): Promise<void> {
    try { await channel.updateProposal(p, note); } catch (error) { log(`[telegram] no se pudo editar ${p.id}: ${errorText(error)}`); }
  }
  async function notice(text: string): Promise<void> {
    try { await channel.sendNotice(text); } catch (error) { log(`[telegram] no se pudo avisar: ${errorText(error)}`); }
  }

  async function launch(p: Proposal): Promise<void> {
    const name = sessionNameFor(p);
    let session: { name: string };
    try {
      session = await deps.ronin.createSession({ repo: p.repo, workflowId: p.workflowId, request: p.request, origen: p.origin, name });
    } catch (error) {
      if (error instanceof RoninError && error.code === "SESSION_ALREADY_EXISTS") {
        // El nombre es único por propuesta: si ya existe, un intento anterior sí la creó
        // pero se perdió la respuesta (timeout, reinicio). Se toma como lanzada.
        await launched(p, name, true);
        return;
      }
      const failed = store.transition(p.id, "failed", deps.now(), { error: errorText(error) });
      store.audit("ronin", "launch_failed", p.id, { error: errorText(error) }, deps.now());
      await edit(failed, `⚠️ No se pudo lanzar: ${errorText(error)}`);
      return;
    }
    await launched(p, session.name, false);
  }

  async function launched(p: Proposal, sessionName: string, recovered: boolean): Promise<void> {
    const updated = store.transition(p.id, "launched", deps.now(), { sessionName, error: null });
    store.trackSession(sessionName, p.id);
    store.audit("ronin", "session_created", p.id, { session: sessionName, ...(recovered ? { recovered: true } : {}) }, deps.now());
    await edit(updated, `✅ Sesión ${sessionName} creada`);
  }

  /** Tras editar, se envía un mensaje nuevo; el encabezado usa p.origin porque el evento ya no está en memoria. */
  async function repropose(p: Proposal): Promise<void> {
    try { store.setMessageId(p.id, await channel.sendProposal(p, null)); }
    catch (error) { log(`[telegram] no se pudo reenviar ${p.id}: ${errorText(error)}`); }
  }

  /** Verifica el estado ANTES del ack, para que el ack vaya antes de cualquier cambio de estado. */
  const expect = (p: Proposal, status: Proposal["status"]) => { if (p.status !== status) throw new InvalidTransition(p.status, status); };

  async function onCallback(event: Extract<ChannelEvent, { type: "callback" }>): Promise<void> {
    const p = store.getProposal(event.proposalId);
    if (!p) { await ack(event.callbackId, "No existe"); return; }
    store.audit("user", event.action, p.id, { index: event.index ?? null }, deps.now());
    try {
      switch (event.action) {
        case "approve":
        case "retry": {
          const from = event.action === "approve" ? "pending" : "failed";
          expect(p, from);
          await ack(event.callbackId, "Lanzando…");
          await launch(store.transition(p.id, "approved", deps.now(), undefined, from));
          return;
        }
        case "reject": {
          expect(p, "pending");
          await ack(event.callbackId, "Ignorada");
          await edit(store.transition(p.id, "rejected", deps.now(), undefined, "pending"), "❌ Ignorada");
          return;
        }
        case "edit": {
          expect(p, "pending");
          await ack(event.callbackId);
          await channel.sendEditMenu(p);
          return;
        }
        case "edit_request": {
          expect(p, "pending");
          await ack(event.callbackId);
          store.setPendingEdit(await channel.askForRequest(p), p.id);
          return;
        }
        case "edit_repo":
        case "edit_workflow": {
          expect(p, "pending");
          const catalog = await deps.ronin.catalog();
          await ack(event.callbackId);
          await channel.sendChoices(p, event.action === "edit_repo" ? "repo" : "workflow",
            event.action === "edit_repo" ? catalog.repos : catalog.workflows.map((w) => w.name));
          return;
        }
        case "set_repo":
        case "set_workflow": {
          expect(p, "pending");
          const catalog = await deps.ronin.catalog();
          const index = event.index ?? -1;
          const patch = event.action === "set_repo"
            ? (catalog.repos[index] !== undefined ? { repo: catalog.repos[index] } : null)
            : (catalog.workflows[index] ? { workflowId: catalog.workflows[index].id, workflowName: catalog.workflows[index].name } : null);
          if (!patch) { await ack(event.callbackId, "Opción inválida"); return; }
          await ack(event.callbackId, "Actualizada");
          await repropose(store.updatePending(p.id, patch, deps.now()));
          return;
        }
      }
    } catch (error) {
      if (error instanceof InvalidTransition) {
        await ack(event.callbackId, p.status === "expired" ? "Expirada" : "Ya no está vigente");
        return;
      }
      throw error;
    }
  }

  async function onMessage(event: Extract<ChannelEvent, { type: "message" }>): Promise<void> {
    if (event.replyToMessageId !== undefined) {
      const proposalId = store.takePendingEdit(event.replyToMessageId);
      if (proposalId) {
        try {
          const updated = store.updatePending(proposalId, { request: capRequest(event.text) }, deps.now());
          store.audit("user", "edit_request", proposalId, {}, deps.now());
          await repropose(updated);
        } catch (error) {
          if (!(error instanceof InvalidTransition)) throw error;
          await notice("Esa propuesta ya no está vigente.");
        }
        return;
      }
      const session = store.findSessionByQuestion(event.replyToMessageId);
      if (session) {
        store.audit("user", "reply_session", session.name, {}, deps.now());
        try {
          await deps.ronin.replySession(session.name, event.text);
        } catch (error) {
          await notice(`⚠️ No pude responder a ${session.name}: ${errorText(error)}`);
          return;
        }
        await notice(`📨 Enviado a ${session.name}`);
        return;
      }
    }
    await notice("Usa los botones de las propuestas, o responde a una pregunta de sesión.");
  }

  return {
    async onInboxEvent(event) {
      if (store.hasEvent(event.id)) return;
      store.saveEvent(event, deps.now());
      store.audit("kitsune", "event", event.id, { kind: event.kind }, deps.now());
      let triage: Triage;
      let catalog: Catalog;
      try {
        catalog = await deps.ronin.catalog();
        triage = await deps.brain.triage(event, catalog);
      } catch (error) {
        store.setTriage(event.id, null, "failed");
        const reason = error instanceof TriageError ? error.message : errorText(error);
        await notice(`⚠️ No pude clasificar: ${event.title}\n${event.url}\n\n${clip(event.body)}\n\n(${reason})`);
        return;
      }
      store.setTriage(event.id, triage, "done");
      if (triage.action === "ignore") return;
      if (triage.action === "notify") {
        await notice(`🦊 ${triage.summary}\n${event.url}`);
        return;
      }
      const workflow = catalog.workflows.find((w) => w.name === triage.workflow);
      if (!workflow) {
        await notice(`🦊 ${triage.request}\n${event.url}\n\n(el workflow ${triage.workflow} ya no está en el catálogo)`);
        return;
      }
      const p = store.createProposal({
        eventId: event.id, repo: triage.repo, workflowId: workflow.id, workflowName: workflow.name,
        request: triage.request, origin: `clickup:${event.meta.taskId}`, title: event.title, url: event.url,
      }, deps.now());
      // Si Telegram falla, la propuesta queda sin message id y redeliver() la reenvía.
      try { store.setMessageId(p.id, await channel.sendProposal(p, event)); }
      catch (error) { log(`[telegram] no se pudo enviar la propuesta ${p.id}: ${errorText(error)}`); }
    },
    async onChannelEvent(event) {
      if (!deps.policy.isAuthorized(event.chatId)) {
        store.audit("kitsune", "unauthorized", String(event.chatId), { type: event.type }, deps.now());
        return;
      }
      if (event.type === "callback") await onCallback(event);
      else await onMessage(event);
    },
    async sweepExpired() {
      let count = 0;
      for (const p of store.listPending()) {
        if (deps.now() - p.createdAt <= deps.ttlMs) continue;
        const expired = store.transition(p.id, "expired", deps.now());
        await edit(expired, "⌛ Expirada");
        count++;
      }
      return count;
    },
    async recoverInterrupted() {
      const interrupted = store.failInterrupted(deps.now());
      for (const p of interrupted) {
        store.audit("kitsune", "launch_interrupted", p.id, {}, deps.now());
        await edit(p, "⚠️ Lanzamiento interrumpido (Kitsune se reinició). Usa 🔁 para reintentar.");
      }
      return interrupted.length;
    },
    async redeliver() {
      let delivered = 0;
      for (const p of store.listUndelivered()) {
        try {
          store.setMessageId(p.id, await channel.sendProposal(p, null));
          delivered++;
        } catch (error) {
          log(`[telegram] reenvío de ${p.id} falló: ${errorText(error)}`);
        }
      }
      return delivered;
    },
  };
}
