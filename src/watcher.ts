import type { Channel } from "./channels/telegram.js";
import type { EventBus, KitsuneEventInput } from "./events.js";
import type { RoninClient } from "./ronin-client.js";
import type { Store } from "./store.js";

export interface Watcher { tick(): Promise<void> }

export function createWatcher(deps: { store: Store; ronin: RoninClient; channel: Channel; events?: EventBus }): Watcher {
  const { store, channel } = deps;
  const emit = (e: KitsuneEventInput) => deps.events?.publish(e);
  // Contador en memoria por nombre de sesión: cuenta ticks CONSECUTIVOS con attention shell/gone
  // y el flujo sin terminar. Justo después de lanzar el pane es shell unos segundos, por eso se
  // exige verlo dos veces seguidas antes de avisar; se reinicia en cuanto deja de cumplirse.
  const stallTicks = new Map<string, number>();
  // Última combinación stage|stagesDone|stagesTotal|needsInput vista por sesión, para publicar session_update
  // solo cuando cambia (incluido needsInput: al contestarse la pregunta la mascota sale de `asking`).
  const lastProgress = new Map<string, string>();
  return {
    async tick() {
      const tracked = store.listActiveSessions();
      if (tracked.length === 0) return;
      const statuses = await deps.ronin.sessionStatus(tracked.map((t) => t.name));
      for (const t of tracked) {
        const status = statuses.find((s) => s.name === t.name);
        if (!status) {
          emit({ type: "session_dead", name: t.name, reason: "ya no existe" });
          await channel.sendNotice(`🫥 La sesión ${t.name} ya no existe`);
          store.updateSession(t.name, { notifiedDone: true });
          stallTicks.delete(t.name);
          lastProgress.delete(t.name);
          continue;
        }
        const progressKey = `${status.stage}|${status.stagesDone}|${status.stagesTotal}|${status.needsInput}`;
        const newQuestion = !!(status.needsInput && status.question && status.question !== t.lastQuestion);
        if (lastProgress.get(t.name) !== progressKey) {
          lastProgress.set(t.name, progressKey);
          emit({ type: "session_update", name: t.name, stage: status.stage, stagesDone: status.stagesDone, stagesTotal: status.stagesTotal });
          // session_update limpia needsInput en los consumidores: si la pregunta sigue abierta y ya se
          // envió a Telegram (p. ej. tras reiniciar el daemon), se vuelve a publicar solo en el bus.
          if (status.needsInput && status.question && !newQuestion) emit({ type: "session_question", name: t.name, question: status.question });
        }
        const stalled = (status.attention === "shell" || status.attention === "gone")
          && (status.stagesTotal === 0 || status.stagesDone < status.stagesTotal);
        if (!stalled) {
          stallTicks.delete(t.name);
        } else {
          const ticks = (stallTicks.get(t.name) ?? 0) + 1;
          if (ticks < 2) {
            stallTicks.set(t.name, ticks);
            continue;
          }
          stallTicks.delete(t.name);
          emit({ type: "session_dead", name: t.name, reason: "el agente se detuvo" });
          await channel.sendNotice(`💤 La sesión ${t.name} se detuvo: el agente ya no está activo (etapa ${status.stage ?? "sin iniciar"}, ${status.stagesDone}/${status.stagesTotal}). Revísala en Ronin.`);
          store.updateSession(t.name, { notifiedDone: true });
          continue;
        }
        if (newQuestion && status.question) {
          emit({ type: "session_question", name: t.name, question: status.question });
          const messageId = await channel.sendQuestion(t.name, status.question, status.options);
          store.updateSession(t.name, { lastQuestion: status.question, questionMessageId: messageId });
        } else if (!status.needsInput && (t.lastQuestion !== null || t.questionMessageId !== null)) {
          // Ya se contestó: se olvida la pregunta para poder reenviarla si vuelve a hacerse.
          store.updateSession(t.name, { lastQuestion: null, questionMessageId: null });
        }
        if (status.gate && status.gate.stage !== t.lastGate) {
          const attempts = status.gate.attempts !== undefined ? ` (${status.gate.attempts} intentos)` : "";
          emit({ type: "error", message: `Falló el gate de ${status.gate.stage} en ${t.name}` });
          await channel.sendNotice(`⚠️ El gate de ${status.gate.stage} falló en ${t.name}${attempts}`);
          store.updateSession(t.name, { lastGate: status.gate.stage });
        }
        if (status.stagesTotal > 0 && status.stagesDone === status.stagesTotal && !status.needsInput) {
          emit({ type: "session_done", name: t.name });
          await channel.sendNotice(`✅ ${t.name} terminó: ${status.stagesDone}/${status.stagesTotal} etapas`);
          store.updateSession(t.name, { notifiedDone: true });
        }
      }
    },
  };
}
