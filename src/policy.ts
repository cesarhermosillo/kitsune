export interface Policy {
  isAuthorized(chatId: number): boolean;
  requiresApproval(action: "launch_session" | "reply_session"): true;
}

/** Fase 1: todo lo que crea o cambia algo requiere ✅. Las reglas de autoaprobación llegan en la Fase 6. */
export function createPolicy(opts: { chatId: number }): Policy {
  return {
    isAuthorized: (chatId) => chatId === opts.chatId,
    requiresApproval: () => true,
  };
}
