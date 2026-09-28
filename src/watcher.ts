import type { Channel } from "./channels/telegram.js";
import type { RoninClient } from "./ronin-client.js";
import type { Store } from "./store.js";

export interface Watcher { tick(): Promise<void> }

export function createWatcher(deps: { store: Store; ronin: RoninClient; channel: Channel }): Watcher {
  const { store, channel } = deps;
  return {
    async tick() {
      const tracked = store.listActiveSessions();
      if (tracked.length === 0) return;
      const statuses = await deps.ronin.sessionStatus(tracked.map((t) => t.name));
      for (const t of tracked) {
        const status = statuses.find((s) => s.name === t.name);
        if (!status) {
          await channel.sendNotice(`🫥 La sesión ${t.name} ya no existe`);
          store.updateSession(t.name, { notifiedDone: true });
          continue;
        }
        if (status.needsInput && status.question && status.question !== t.lastQuestion) {
          const messageId = await channel.sendQuestion(t.name, status.question, status.options);
          store.updateSession(t.name, { lastQuestion: status.question, questionMessageId: messageId });
        } else if (!status.needsInput && (t.lastQuestion !== null || t.questionMessageId !== null)) {
          // Ya se contestó: se olvida la pregunta para poder reenviarla si vuelve a hacerse.
          store.updateSession(t.name, { lastQuestion: null, questionMessageId: null });
        }
        if (status.gate && status.gate.stage !== t.lastGate) {
          const attempts = status.gate.attempts !== undefined ? ` (${status.gate.attempts} intentos)` : "";
          await channel.sendNotice(`⚠️ El gate de ${status.gate.stage} falló en ${t.name}${attempts}`);
          store.updateSession(t.name, { lastGate: status.gate.stage });
        }
        if (status.stagesTotal > 0 && status.stagesDone === status.stagesTotal && !status.needsInput) {
          await channel.sendNotice(`✅ ${t.name} terminó: ${status.stagesDone}/${status.stagesTotal} etapas`);
          store.updateSession(t.name, { notifiedDone: true });
        }
      }
    },
  };
}
