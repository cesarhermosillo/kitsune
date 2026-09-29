import { capRequest, TriageError, type Brain } from "./brain.js";
import { parseUpdate, workflowCheck, type Channel, type ChannelEvent, type WorkflowOption } from "./channels/telegram.js";
import type { TgUpdate } from "./channels/telegram-api.js";
import type { EventBus, KitsuneEventInput } from "./events.js";
import type { Policy } from "./policy.js";
import { InvalidTransition } from "./proposals.js";
import { RoninError, type RoninClient } from "./ronin-client.js";
import type { Store } from "./store.js";
import type { Catalog, CatalogWorkflow, InboxEvent, Proposal, Triage } from "./types.js";

export interface AppDeps {
  store: Store; brain: Brain; ronin: RoninClient; channel: Channel; policy: Policy; now: () => number; ttlMs: number;
  /** Nombres de workflows favoritos, en el orden en que deben mostrarse al elegir workflow (config.favoriteWorkflows). */
  favoriteWorkflows: string[];
  log?: (line: string) => void;
  events?: EventBus;
}
export interface KitsuneApp {
  onInboxEvent(event: InboxEvent): Promise<void>;
  onChannelEvent(event: ChannelEvent): Promise<void>;
  sweepExpired(): Promise<number>;
  /** Al arrancar: las propuestas que quedaron en `approved` (el daemon murió a medio lanzar) pasan a `failed`. */
  recoverInterrupted(): Promise<number>;
  /** Reenvía las propuestas pendientes cuyo envío a Telegram falló (sin message id). Devuelve cuántas se entregaron. */
  redeliver(): Promise<number>;
  /** Opciones de workflow para lanzar la propuesta (mascota): sugerido + favoritos en `main`, el resto en `other`. */
  workflowOptions(id: string): Promise<OptionsResult>;
  /** Lanza la propuesta con el workflow elegido por id. Mismo candado que el ✅ de Telegram: una sesión como máximo. */
  launchProposal(id: string, workflowId: string, via: Via): Promise<LaunchResult>;
  rejectProposal(id: string, via: Via): Promise<RejectResult>;
  retryProposal(id: string, via: Via): Promise<LaunchResult>;
}

export type Via = "pet" | "telegram";
export interface WorkflowChoice { id: string; name: string; suggested: boolean; favorite: boolean; dangerous: boolean; group: "main" | "other" }
export type ActionErrorCode = "not_found" | "not_pending" | "expired" | "unknown_workflow" | "ronin_unavailable" | "launch_failed";
export type ActionError = { ok: false; code: ActionErrorCode; message: string };
export type LaunchResult = { ok: true; status: "launched"; sessionName: string } | ActionError;
export type RejectResult = { ok: true; status: "rejected" } | ActionError;
export type OptionsResult = { ok: true; title: string; choices: WorkflowChoice[] } | ActionError;

const ACTION_MESSAGES: Record<Exclude<ActionErrorCode, "launch_failed">, string> = {
  not_found: "La propuesta no existe",
  not_pending: "Ya no está vigente",
  expired: "Expirada",
  unknown_workflow: "Ese workflow ya no existe en Ronin",
  ronin_unavailable: "Ronin no responde, intenta de nuevo",
};
const actionError = (code: Exclude<ActionErrorCode, "launch_failed">): ActionError => ({ ok: false, code, message: ACTION_MESSAGES[code] });

/** Valida existencia y estado antes de actuar: not_found, expired, o not_pending si no está en `required`. */
function checkState(p: Proposal | null, ...required: Proposal["status"][]): ActionError | null {
  if (!p) return actionError("not_found");
  if (p.status === "expired") return actionError("expired");
  if (!required.includes(p.status)) return actionError("not_pending");
  return null;
}

/** Estados desde los que se puede ignorar (❌): pendiente, o fallida (spec §4, fila de reintento). */
const REJECTABLE: Proposal["status"][] = ["pending", "failed"];

/** Como /state: los textos que van a la mascota se acotan a 500 caracteres (sin elipsis). */
const clipTitle = (text: string) => text.slice(0, 500);
const clip = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max)}…` : text);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const hasMergeDeploy = (w: CatalogWorkflow): boolean => w.stages.includes("merge") || w.stages.includes("deploy");
const workflowLabel = (w: CatalogWorkflow, suggested: boolean): string =>
  `${suggested ? "⭐ " : ""}${w.name}${hasMergeDeploy(w) ? " ⚠️ merge/deploy" : ""}`;

/** Índices del catálogo para el selector inicial: el sugerido (primero si no es favorito) + los favoritos presentes, en su orden. */
function mainWorkflowIndices(p: Proposal, catalog: Catalog, favorites: string[]): number[] {
  const indexByName = new Map(catalog.workflows.map((w, i) => [w.name, i] as const));
  const favoriteNames = favorites.filter((name) => indexByName.has(name));
  const indices: number[] = [];
  const suggestedIndex = indexByName.get(p.workflowName);
  if (suggestedIndex !== undefined && !favoriteNames.includes(p.workflowName)) indices.push(suggestedIndex);
  for (const name of favoriteNames) {
    indices.push(indexByName.get(name)!);
  }
  return indices;
}

/** Selector inicial de ✅ Lanzar (Telegram). */
function favoriteWorkflowOptions(p: Proposal, catalog: Catalog, favorites: string[]): WorkflowOption[] {
  return mainWorkflowIndices(p, catalog, favorites).map((index) => {
    const w = catalog.workflows[index];
    return { index, label: workflowLabel(w, w.name === p.workflowName), check: workflowCheck(w.name) };
  });
}

/** Opciones para la mascota: mismo `main` que el selector de Telegram; `other` = el resto del catálogo en su orden. */
function workflowChoices(p: Proposal, catalog: Catalog, favorites: string[]): WorkflowChoice[] {
  const main = mainWorkflowIndices(p, catalog, favorites);
  const choice = (w: CatalogWorkflow, group: WorkflowChoice["group"]): WorkflowChoice => ({
    id: w.id, name: w.name, suggested: w.name === p.workflowName, favorite: favorites.includes(w.name), dangerous: hasMergeDeploy(w), group,
  });
  return [
    ...main.map((i) => choice(catalog.workflows[i], "main")),
    ...catalog.workflows.filter((_, i) => !main.includes(i)).map((w) => choice(w, "other")),
  ];
}

/** Pantalla "Otro…": todo el catálogo, mismo formato de etiquetas. */
function allWorkflowOptions(p: Proposal, catalog: Catalog): WorkflowOption[] {
  return catalog.workflows.map((w, index) => ({ index, label: workflowLabel(w, w.name === p.workflowName), check: workflowCheck(w.name) }));
}

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
  const emit = (e: KitsuneEventInput) => deps.events?.publish(e);

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
  async function editSelector(messageId: number, text: string): Promise<void> {
    try { await channel.editRaw(messageId, text); } catch (error) { log(`[telegram] no se pudo editar el selector: ${errorText(error)}`); }
  }

  /**
   * Lee el catálogo de Ronin antes de acusar recibo del toque. Si Ronin no responde, el error
   * NO debe escapar (el spinner del botón se quedaría colgado sin avisar a nadie): se acusa
   * recibo con un aviso y se devuelve null; la propuesta sigue pending y nada se lanza.
   */
  async function safeCatalog(callbackId: string): Promise<Catalog | null> {
    try { return await deps.ronin.catalog(); }
    catch (error) {
      log(`[telegram] catalog falló al procesar el callback: ${errorText(error)}`);
      await ack(callbackId, "Ronin no responde, intenta de nuevo");
      return null;
    }
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
      emit({ type: "proposal_resolved", id: p.id, status: "failed" });
      emit({ type: "error", message: `No se pudo lanzar: ${errorText(error)}` });
      await edit(failed, `⚠️ No se pudo lanzar: ${errorText(error)}`);
      return;
    }
    await launched(p, session.name, false);
  }

  async function launched(p: Proposal, sessionName: string, recovered: boolean): Promise<void> {
    const updated = store.transition(p.id, "launched", deps.now(), { sessionName, error: null });
    store.trackSession(sessionName, p.id);
    store.audit("ronin", "session_created", p.id, { session: sessionName, ...(recovered ? { recovered: true } : {}) }, deps.now());
    emit({ type: "proposal_resolved", id: p.id, status: "launched", sessionName });
    await edit(updated, `✅ Sesión ${sessionName} creada`);
  }

  /** Tras launch(), el resultado se lee del store: launched → sessionName; si no, launch_failed con el error guardado. */
  function launchOutcome(id: string): LaunchResult {
    const after = store.getProposal(id);
    if (after?.status === "launched" && after.sessionName) return { ok: true, status: "launched", sessionName: after.sessionName };
    return { ok: false, code: "launch_failed", message: after?.error || "No se pudo lanzar" };
  }

  /**
   * Candado único para ambos canales: `store.approveWith` es una transacción síncrona pending → approved;
   * solo un llamador la gana y el resto recibe InvalidTransition (que el llamador traduce). Nunca dos sesiones por propuesta.
   */
  async function launchWith(p: Proposal, wf: CatalogWorkflow, via: Via): Promise<LaunchResult> {
    const approved = store.approveWith(p.id, { workflowId: wf.id, workflowName: wf.name }, deps.now());
    store.audit("user", "launch", p.id, { via, workflow: wf.name }, deps.now());
    await launch(approved);
    return launchOutcome(p.id);
  }

  /** failed → approved (atómico, desde `failed`) y relanza. Lanza InvalidTransition si otro canal ganó. */
  async function doRetry(p: Proposal, via: Via): Promise<LaunchResult> {
    const approved = store.transition(p.id, "approved", deps.now(), undefined, "failed");
    store.audit("user", "retry", p.id, { via }, deps.now());
    await launch(approved);
    return launchOutcome(p.id);
  }

  /**
   * pending|failed → rejected, atómico desde el estado que se leyó (`p.status`): si otro canal
   * lo cambió entretanto, `transition` lanza InvalidTransition (el llamador lo vuelve not_pending).
   */
  async function doReject(p: Proposal, via: Via): Promise<RejectResult> {
    const rejected = store.transition(p.id, "rejected", deps.now(), undefined, p.status);
    store.audit("user", "reject", p.id, { via }, deps.now());
    emit({ type: "proposal_resolved", id: p.id, status: "rejected" });
    await edit(rejected, "❌ Ignorada");
    return { ok: true, status: "rejected" };
  }

  /** Ejecuta una acción de estado; una InvalidTransition (carrera con otro canal) se vuelve not_pending. */
  async function guarded<T>(action: () => Promise<T>): Promise<T | ActionError> {
    try { return await action(); }
    catch (error) {
      if (error instanceof InvalidTransition) return actionError("not_pending");
      throw error;
    }
  }

  async function catalogOrNull(): Promise<Catalog | null> {
    try { return await deps.ronin.catalog(); }
    catch (error) { log(`[acciones] catalog falló: ${errorText(error)}`); return null; }
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
        case "approve": {
          expect(p, "pending");
          const catalog = await safeCatalog(event.callbackId);
          if (!catalog) return;
          await ack(event.callbackId, "Elige el workflow");
          const title = p.title || p.origin;
          await channel.sendWorkflowChoice(p, `¿Con qué workflow lanzo «${title}»?`, favoriteWorkflowOptions(p, catalog, deps.favoriteWorkflows), { other: true, cancel: true });
          return;
        }
        case "other_workflows": {
          expect(p, "pending");
          const catalog = await safeCatalog(event.callbackId);
          if (!catalog) return;
          await ack(event.callbackId);
          const title = p.title || p.origin;
          await channel.sendWorkflowChoice(p, `¿Con qué workflow lanzo «${title}»?`, allWorkflowOptions(p, catalog), {});
          return;
        }
        case "cancel_launch": {
          expect(p, "pending");
          await ack(event.callbackId, "Cancelado");
          return;
        }
        case "launch_with": {
          expect(p, "pending");
          const catalog = await safeCatalog(event.callbackId);
          if (!catalog) return;
          const wf = catalog.workflows[event.index ?? -1];
          if (!wf || workflowCheck(wf.name) !== event.check) { await ack(event.callbackId, "Opción inválida, vuelve a tocar ✅"); return; }
          await ack(event.callbackId, "Lanzando…");
          const result = await launchWith(p, wf, "telegram");
          if (result.ok) await editSelector(event.messageId, `🚀 Lanzada con ${wf.name}`);
          return;
        }
        case "retry": {
          expect(p, "failed");
          await ack(event.callbackId, "Lanzando…");
          await doRetry(p, "telegram");
          return;
        }
        case "reject": {
          if (!REJECTABLE.includes(p.status)) throw new InvalidTransition(p.status, "rejected");
          await ack(event.callbackId, "Ignorada");
          await doReject(p, "telegram");
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
      emit({ type: "triage_started", title: event.title });
      store.audit("kitsune", "event", event.id, { kind: event.kind }, deps.now());
      let triage: Triage;
      let catalog: Catalog;
      try {
        catalog = await deps.ronin.catalog();
        triage = await deps.brain.triage(event, catalog);
      } catch (error) {
        store.setTriage(event.id, null, "failed");
        emit({ type: "event_triaged", title: event.title, action: "failed" });
        const reason = error instanceof TriageError ? error.message : errorText(error);
        emit({ type: "error", message: `No pude clasificar: ${event.title}` });
        await notice(`⚠️ No pude clasificar: ${event.title}\n${event.url}\n\n${clip(event.body)}\n\n(${reason})`);
        return;
      }
      store.setTriage(event.id, triage, "done");
      emit({ type: "event_triaged", title: event.title, action: triage.action });
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
      emit({ type: "proposal_created", id: p.id, title: p.title, url: p.url, repo: p.repo, workflow: p.workflowName });
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
        emit({ type: "proposal_resolved", id: p.id, status: "expired" });
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
    async workflowOptions(id) {
      const p = store.getProposal(id);
      const invalid = checkState(p, "pending");
      if (invalid) return invalid;
      const catalog = await catalogOrNull();
      if (!catalog) return actionError("ronin_unavailable");
      return { ok: true, title: clipTitle(p!.title || p!.origin), choices: workflowChoices(p!, catalog, deps.favoriteWorkflows) };
    },
    async launchProposal(id, workflowId, via) {
      const p = store.getProposal(id);
      const invalid = checkState(p, "pending");
      if (invalid) return invalid;
      const catalog = await catalogOrNull();
      if (!catalog) return actionError("ronin_unavailable");
      const wf = catalog.workflows.find((w) => w.id === workflowId);
      if (!wf) return actionError("unknown_workflow");
      return guarded(() => launchWith(p!, wf, via));
    },
    async rejectProposal(id, via) {
      const p = store.getProposal(id);
      const invalid = checkState(p, ...REJECTABLE);
      if (invalid) return invalid;
      return guarded(() => doReject(p!, via));
    },
    async retryProposal(id, via) {
      const p = store.getProposal(id);
      const invalid = checkState(p, "failed");
      if (invalid) return invalid;
      return guarded(() => doRetry(p!, via));
    },
  };
}
