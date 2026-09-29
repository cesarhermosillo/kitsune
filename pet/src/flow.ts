import type { ApiResult, WorkflowChoice } from "./api";

export type Flow =
  | { view: "list" }
  | { view: "choose"; proposalId: string; title: string; choices: WorkflowChoice[]; showOther: boolean }
  | { view: "confirm"; kind: "launch"; proposalId: string; title: string; workflow: WorkflowChoice }
  | { view: "confirm"; kind: "reject"; proposalId: string; title: string }
  | { view: "busy"; label: string }
  | { view: "result"; ok: boolean; text: string };

export type FlowAction =
  | { type: "open_choose"; proposalId: string; title: string; choices: WorkflowChoice[] }
  | { type: "show_other" }
  | { type: "pick"; workflowId: string }
  | { type: "ask_reject"; proposalId: string; title: string }
  | { type: "busy"; label: string }
  | { type: "done"; ok: boolean; text: string }
  | { type: "cancel" };

export const LIST: Flow = { view: "list" };

export function flowReducer(f: Flow, a: FlowAction): Flow {
  switch (a.type) {
    case "open_choose":
      return {
        view: "choose",
        proposalId: a.proposalId,
        title: a.title,
        choices: a.choices,
        showOther: false,
      };
    case "show_other":
      return f.view === "choose" ? { ...f, showOther: true } : f;
    case "pick": {
      if (f.view !== "choose") return f;
      const workflow = f.choices.find((c) => c.id === a.workflowId);
      return workflow
        ? {
            view: "confirm",
            kind: "launch",
            proposalId: f.proposalId,
            title: f.title,
            workflow,
          }
        : f;
    }
    case "ask_reject":
      return {
        view: "confirm",
        kind: "reject",
        proposalId: a.proposalId,
        title: a.title,
      };
    case "busy":
      return { view: "busy", label: a.label };
    case "done":
      return { view: "result", ok: a.ok, text: a.text };
    case "cancel":
      return LIST;
  }
}

export function visibleChoices(f: Extract<Flow, { view: "choose" }>): WorkflowChoice[] {
  return f.choices.filter((c) => c.group === "main" || f.showOther);
}

export function choiceLabel(c: WorkflowChoice): string {
  return `${c.suggested ? "⭐ " : ""}${c.name}${c.dangerous ? " ⚠️ merge/deploy" : ""}`;
}

export function confirmText(f: Extract<Flow, { view: "confirm" }>): {
  question: string;
  yes: string;
  danger: boolean;
} {
  if (f.kind === "reject")
    return { question: `¿Ignorar «${f.title}»?`, yes: "Sí, ignorar", danger: false };
  return {
    question: `¿Lanzar «${f.title}» con ${f.workflow.name}?`,
    yes: f.workflow.dangerous ? "Sí, lanzar (hace merge/deploy)" : "Sí, lanzar",
    danger: f.workflow.dangerous,
  };
}

export function resultText(r: ApiResult<{ status: string; sessionName?: string }>): {
  ok: boolean;
  text: string;
} {
  if (r.ok) {
    if (r.data.status === "rejected") {
      return { ok: true, text: "❌ Ignorada" };
    }
    return { ok: true, text: `✅ Sesión ${r.data.sessionName} creada` };
  }
  if (r.code === "launch_failed") {
    return { ok: false, text: `⚠️ No se pudo lanzar: ${r.message}` };
  }
  if (r.code === "not_pending") {
    return { ok: false, text: "⚠️ Ya no está vigente" };
  }
  if (r.code === "unreachable") {
    // Timeout/abort del cliente: la acción pudo haberse aplicado igual (un lanzamiento tarda).
    return { ok: false, text: "⚠️ Sin respuesta de Kitsune; revisa en unos segundos" };
  }
  return { ok: false, text: `⚠️ ${r.message}` };
}

/**
 * Secuencia monótona del flujo de la burbuja: cada cambio de flujo (acción del usuario,
 * cierre de la burbuja) la incrementa. Una respuesta asíncrona solo se aplica si la
 * secuencia que capturó antes del await sigue siendo la actual.
 */
export function createFlowSeq() {
  let seq = 0;
  return {
    bump: (): number => ++seq,
    current: (): number => seq,
    isCurrent: (token: number): boolean => token === seq,
  };
}
