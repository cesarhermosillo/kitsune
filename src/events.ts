export type TriageOutcome = "propose_session" | "notify" | "ignore" | "failed";
export type KitsuneEvent =
  | { type: "triage_started"; at: number; title: string }
  | { type: "event_triaged"; at: number; title: string; action: TriageOutcome }
  | { type: "proposal_created"; at: number; id: string; title: string; url: string; repo: string; workflow: string }
  | { type: "proposal_resolved"; at: number; id: string; status: "launched" | "failed" | "rejected" | "expired"; sessionName?: string }
  | { type: "session_update"; at: number; name: string; stage: string | null; stagesDone: number; stagesTotal: number }
  | { type: "session_question"; at: number; name: string; question: string }
  | { type: "session_done"; at: number; name: string }
  | { type: "session_dead"; at: number; name: string; reason: string }
  | { type: "error"; at: number; message: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type KitsuneEventInput = DistributiveOmit<KitsuneEvent, "at">;

export interface EventBus {
  publish(event: KitsuneEventInput): void;
  subscribe(listener: (event: KitsuneEvent) => void): () => void;
}

/** Bus en memoria, sin historial: quien se conecta tarde pide la foto completa (/state). */
export function createEventBus(now: () => number = Date.now): EventBus {
  const listeners = new Set<(event: KitsuneEvent) => void>();
  return {
    publish(input) {
      const event = { ...input, at: now() } as KitsuneEvent;
      for (const listener of [...listeners]) {
        try { listener(event); } catch { /* un suscriptor roto no afecta a los demás */ }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
