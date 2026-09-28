import { TriageError, type Brain } from "./brain.js";
import type { Channel, ChannelEvent } from "./channels/telegram.js";
import type { Policy } from "./policy.js";
import { InvalidTransition } from "./proposals.js";
import type { RoninClient } from "./ronin-client.js";
import type { Store } from "./store.js";
import type { Catalog, InboxEvent, Proposal, Triage } from "./types.js";

export interface AppDeps { store: Store; brain: Brain; ronin: RoninClient; channel: Channel; policy: Policy; now: () => number; ttlMs: number }
export interface KitsuneApp {
  onInboxEvent(event: InboxEvent): Promise<void>;
  onChannelEvent(event: ChannelEvent): Promise<void>;
  sweepExpired(): Promise<number>;
}

const clip = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max)}…` : text);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createKitsuneApp(deps: AppDeps): KitsuneApp {
  const { store, channel } = deps;

  async function launch(p: Proposal): Promise<void> {
    try {
      const session = await deps.ronin.createSession({ repo: p.repo, workflowId: p.workflowId, request: p.request, origen: p.origin });
      const launched = store.transition(p.id, "launched", deps.now(), { sessionName: session.name, error: null });
      store.trackSession(session.name, p.id);
      store.audit("ronin", "session_created", p.id, { session: session.name }, deps.now());
      await channel.updateProposal(launched, `✅ Sesión ${session.name} creada`);
    } catch (error) {
      const failed = store.transition(p.id, "failed", deps.now(), { error: errorText(error) });
      store.audit("ronin", "launch_failed", p.id, { error: errorText(error) }, deps.now());
      await channel.updateProposal(failed, `⚠️ No se pudo lanzar: ${errorText(error)}`);
    }
  }

  /** Tras editar, se envía un mensaje nuevo; el encabezado usa p.origin porque el evento ya no está en memoria. */
  async function repropose(p: Proposal): Promise<void> {
    store.setMessageId(p.id, await channel.sendProposal(p, null));
  }

  async function onCallback(event: Extract<ChannelEvent, { type: "callback" }>): Promise<void> {
    const p = store.getProposal(event.proposalId);
    if (!p) { await channel.ackCallback(event.callbackId, "No existe"); return; }
    store.audit("user", event.action, p.id, { index: event.index ?? null }, deps.now());
    try {
      switch (event.action) {
        case "approve":
        case "retry": {
          const approved = store.transition(p.id, "approved", deps.now());
          await channel.ackCallback(event.callbackId, "Lanzando…");
          await launch(approved);
          return;
        }
        case "reject": {
          const rejected = store.transition(p.id, "rejected", deps.now());
          await channel.ackCallback(event.callbackId, "Ignorada");
          await channel.updateProposal(rejected, "❌ Ignorada");
          return;
        }
        case "edit": {
          if (p.status !== "pending") throw new InvalidTransition(p.status, "pending");
          await channel.ackCallback(event.callbackId);
          await channel.sendEditMenu(p);
          return;
        }
        case "edit_request": {
          if (p.status !== "pending") throw new InvalidTransition(p.status, "pending");
          await channel.ackCallback(event.callbackId);
          store.setPendingEdit(await channel.askForRequest(p), p.id);
          return;
        }
        case "edit_repo":
        case "edit_workflow": {
          if (p.status !== "pending") throw new InvalidTransition(p.status, "pending");
          const catalog = await deps.ronin.catalog();
          await channel.ackCallback(event.callbackId);
          await channel.sendChoices(p, event.action === "edit_repo" ? "repo" : "workflow",
            event.action === "edit_repo" ? catalog.repos : catalog.workflows.map((w) => w.name));
          return;
        }
        case "set_repo":
        case "set_workflow": {
          const catalog = await deps.ronin.catalog();
          const index = event.index ?? -1;
          const patch = event.action === "set_repo"
            ? (catalog.repos[index] !== undefined ? { repo: catalog.repos[index] } : null)
            : (catalog.workflows[index] ? { workflowId: catalog.workflows[index].id, workflowName: catalog.workflows[index].name } : null);
          if (!patch) { await channel.ackCallback(event.callbackId, "Opción inválida"); return; }
          const updated = store.updatePending(p.id, patch, deps.now());
          await channel.ackCallback(event.callbackId, "Actualizada");
          await repropose(updated);
          return;
        }
      }
    } catch (error) {
      if (error instanceof InvalidTransition) { await channel.ackCallback(event.callbackId, "Ya no está vigente"); return; }
      throw error;
    }
  }

  async function onMessage(event: Extract<ChannelEvent, { type: "message" }>): Promise<void> {
    if (event.replyToMessageId !== undefined) {
      const proposalId = store.takePendingEdit(event.replyToMessageId);
      if (proposalId) {
        try {
          const updated = store.updatePending(proposalId, { request: event.text.slice(0, 8000) }, deps.now());
          store.audit("user", "edit_request", proposalId, {}, deps.now());
          await repropose(updated);
        } catch (error) {
          if (!(error instanceof InvalidTransition)) throw error;
          await channel.sendNotice("Esa propuesta ya no está vigente.");
        }
        return;
      }
      const session = store.findSessionByQuestion(event.replyToMessageId);
      if (session) {
        store.audit("user", "reply_session", session.name, {}, deps.now());
        try {
          await deps.ronin.replySession(session.name, event.text);
          await channel.sendNotice(`📨 Enviado a ${session.name}`);
        } catch (error) {
          await channel.sendNotice(`⚠️ No pude responder a ${session.name}: ${errorText(error)}`);
        }
        return;
      }
    }
    await channel.sendNotice("Usa los botones de las propuestas, o responde a una pregunta de sesión.");
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
        await channel.sendNotice(`⚠️ No pude clasificar: ${event.title}\n${event.url}\n\n${clip(event.body)}\n\n(${reason})`);
        return;
      }
      store.setTriage(event.id, triage, "done");
      if (triage.action === "ignore") return;
      if (triage.action === "notify") {
        await channel.sendNotice(`🦊 ${triage.summary}\n${event.url}`);
        return;
      }
      const workflow = catalog.workflows.find((w) => w.name === triage.workflow);
      if (!workflow) {
        await channel.sendNotice(`🦊 ${triage.request}\n${event.url}\n\n(el workflow ${triage.workflow} ya no está en el catálogo)`);
        return;
      }
      const p = store.createProposal({
        eventId: event.id, repo: triage.repo, workflowId: workflow.id, workflowName: workflow.name,
        request: triage.request, origin: `clickup:${event.meta.taskId}`,
      }, deps.now());
      store.setMessageId(p.id, await channel.sendProposal(p, event));
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
        await channel.updateProposal(expired, "⌛ Expirada");
        count++;
      }
      return count;
    },
  };
}
