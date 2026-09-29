import { describe, it, expect } from "vitest";
import type { WorkflowChoice, ApiResult } from "./api";
import {
  Flow,
  FlowAction,
  LIST,
  flowReducer,
  visibleChoices,
  choiceLabel,
  confirmText,
  resultText,
} from "./flow";

describe("flowReducer", () => {
  describe("open_choose action", () => {
    it("transitions from list to choose with showOther: false", () => {
      const choices: WorkflowChoice[] = [
        { id: "w1", name: "Merge", suggested: true, favorite: false, dangerous: false, group: "main" },
        { id: "w2", name: "Deploy", suggested: false, favorite: false, dangerous: false, group: "other" },
      ];

      const action: FlowAction = {
        type: "open_choose",
        proposalId: "p123",
        title: "Add feature",
        choices,
      };

      const result = flowReducer(LIST, action);
      expect(result).toEqual({
        view: "choose",
        proposalId: "p123",
        title: "Add feature",
        choices,
        showOther: false,
      });
    });

    it("visibleChoices filters to main group when showOther is false", () => {
      const choices: WorkflowChoice[] = [
        { id: "w1", name: "Merge", suggested: true, favorite: false, dangerous: false, group: "main" },
        { id: "w2", name: "Deploy", suggested: false, favorite: false, dangerous: false, group: "main" },
        { id: "w3", name: "Custom", suggested: false, favorite: false, dangerous: false, group: "other" },
      ];

      const chooseState: Extract<Flow, { view: "choose" }> = {
        view: "choose",
        proposalId: "p123",
        title: "Test",
        choices,
        showOther: false,
      };

      const visible = visibleChoices(chooseState);
      expect(visible).toHaveLength(2);
      expect(visible[0].id).toBe("w1");
      expect(visible[1].id).toBe("w2");
    });
  });

  describe("show_other action", () => {
    it("updates showOther to true in choose view", () => {
      const choices: WorkflowChoice[] = [
        { id: "w1", name: "Merge", suggested: true, favorite: false, dangerous: false, group: "main" },
        { id: "w2", name: "Custom", suggested: false, favorite: false, dangerous: false, group: "other" },
      ];

      const chooseState: Extract<Flow, { view: "choose" }> = {
        view: "choose",
        proposalId: "p123",
        title: "Test",
        choices,
        showOther: false,
      };

      const result = flowReducer(chooseState, { type: "show_other" });
      expect(result.view).toBe("choose");
      if (result.view === "choose") {
        expect(result.showOther).toBe(true);
      }
    });

    it("visibleChoices includes other group when showOther is true", () => {
      const choices: WorkflowChoice[] = [
        { id: "w1", name: "Merge", suggested: true, favorite: false, dangerous: false, group: "main" },
        { id: "w2", name: "Custom", suggested: false, favorite: false, dangerous: false, group: "other" },
      ];

      const chooseState: Extract<Flow, { view: "choose" }> = {
        view: "choose",
        proposalId: "p123",
        title: "Test",
        choices,
        showOther: true,
      };

      const visible = visibleChoices(chooseState);
      expect(visible).toHaveLength(2);
      expect(visible.map((c) => c.id)).toContain("w1");
      expect(visible.map((c) => c.id)).toContain("w2");
    });

    it("show_other on non-choose view is a no-op", () => {
      const result = flowReducer(LIST, { type: "show_other" });
      expect(result).toEqual(LIST);
    });
  });

  describe("pick action", () => {
    it("transitions choose to confirm (launch) when workflow id exists", () => {
      const workflow: WorkflowChoice = {
        id: "w1",
        name: "Merge",
        suggested: true,
        favorite: false,
        dangerous: false,
        group: "main",
      };
      const choices: WorkflowChoice[] = [workflow];

      const chooseState: Extract<Flow, { view: "choose" }> = {
        view: "choose",
        proposalId: "p123",
        title: "Add feature",
        choices,
        showOther: false,
      };

      const result = flowReducer(chooseState, { type: "pick", workflowId: "w1" });
      expect(result).toEqual({
        view: "confirm",
        kind: "launch",
        proposalId: "p123",
        title: "Add feature",
        workflow,
      });
    });

    it("remains unchanged when workflow id doesn't exist", () => {
      const choices: WorkflowChoice[] = [
        { id: "w1", name: "Merge", suggested: true, favorite: false, dangerous: false, group: "main" },
      ];

      const chooseState: Extract<Flow, { view: "choose" }> = {
        view: "choose",
        proposalId: "p123",
        title: "Add feature",
        choices,
        showOther: false,
      };

      const result = flowReducer(chooseState, { type: "pick", workflowId: "nonexistent" });
      expect(result).toEqual(chooseState);
    });

    it("is a no-op when not in choose view", () => {
      const result = flowReducer(LIST, { type: "pick", workflowId: "w1" });
      expect(result).toEqual(LIST);
    });
  });

  describe("ask_reject action", () => {
    it("transitions to confirm (reject) view", () => {
      const result = flowReducer(LIST, {
        type: "ask_reject",
        proposalId: "p123",
        title: "Bad change",
      });

      expect(result).toEqual({
        view: "confirm",
        kind: "reject",
        proposalId: "p123",
        title: "Bad change",
      });
    });
  });

  describe("busy action", () => {
    it("transitions to busy view with label", () => {
      const result = flowReducer(LIST, { type: "busy", label: "Lanzando..." });
      expect(result).toEqual({
        view: "busy",
        label: "Lanzando...",
      });
    });
  });

  describe("done action", () => {
    it("transitions to result view with ok=true", () => {
      const result = flowReducer(LIST, { type: "done", ok: true, text: "✅ Sesión S123 creada" });
      expect(result).toEqual({
        view: "result",
        ok: true,
        text: "✅ Sesión S123 creada",
      });
    });

    it("transitions to result view with ok=false", () => {
      const result = flowReducer(LIST, {
        type: "done",
        ok: false,
        text: "⚠️ No se pudo lanzar",
      });
      expect(result).toEqual({
        view: "result",
        ok: false,
        text: "⚠️ No se pudo lanzar",
      });
    });
  });

  describe("cancel action", () => {
    it("returns to LIST from any view", () => {
      const choices: WorkflowChoice[] = [
        { id: "w1", name: "Merge", suggested: true, favorite: false, dangerous: false, group: "main" },
      ];
      const chooseState: Extract<Flow, { view: "choose" }> = {
        view: "choose",
        proposalId: "p123",
        title: "Test",
        choices,
        showOther: false,
      };

      const result = flowReducer(chooseState, { type: "cancel" });
      expect(result).toEqual(LIST);
    });
  });
});

describe("choiceLabel", () => {
  it("adds ⭐ prefix for suggested choices", () => {
    const choice: WorkflowChoice = {
      id: "w1",
      name: "Merge",
      suggested: true,
      favorite: false,
      dangerous: false,
      group: "main",
    };

    const label = choiceLabel(choice);
    expect(label).toContain("⭐");
    expect(label).toContain("Merge");
  });

  it("omits ⭐ for non-suggested choices", () => {
    const choice: WorkflowChoice = {
      id: "w1",
      name: "Deploy",
      suggested: false,
      favorite: false,
      dangerous: false,
      group: "main",
    };

    const label = choiceLabel(choice);
    expect(label).not.toContain("⭐");
    expect(label).toBe("Deploy");
  });

  it("adds ⚠️ suffix for dangerous choices", () => {
    const choice: WorkflowChoice = {
      id: "w1",
      name: "Delete",
      suggested: false,
      favorite: false,
      dangerous: true,
      group: "main",
    };

    const label = choiceLabel(choice);
    expect(label).toContain("⚠️");
    expect(label).toContain("merge/deploy");
  });

  it("combines ⭐ and ⚠️ for suggested dangerous choices", () => {
    const choice: WorkflowChoice = {
      id: "w1",
      name: "Deploy",
      suggested: true,
      favorite: false,
      dangerous: true,
      group: "main",
    };

    const label = choiceLabel(choice);
    expect(label).toContain("⭐");
    expect(label).toContain("⚠️");
  });
});

describe("confirmText", () => {
  describe("reject kind", () => {
    it("returns reject confirmation text", () => {
      const rejectState: Extract<Flow, { view: "confirm"; kind: "reject" }> = {
        view: "confirm",
        kind: "reject",
        proposalId: "p123",
        title: "Test PR",
      };

      const text = confirmText(rejectState);
      expect(text.question).toBe("¿Ignorar «Test PR»?");
      expect(text.yes).toBe("Sí, ignorar");
      expect(text.danger).toBe(false);
    });
  });

  describe("launch kind", () => {
    it("returns dangerous launch confirmation text", () => {
      const workflow: WorkflowChoice = {
        id: "w1",
        name: "Deploy to Prod",
        suggested: false,
        favorite: false,
        dangerous: true,
        group: "main",
      };

      const confirmState: Extract<Flow, { view: "confirm"; kind: "launch" }> = {
        view: "confirm",
        kind: "launch",
        proposalId: "p123",
        title: "Critical Fix",
        workflow,
      };

      const text = confirmText(confirmState);
      expect(text.question).toBe("¿Lanzar «Critical Fix» con Deploy to Prod?");
      expect(text.yes).toBe("Sí, lanzar (hace merge/deploy)");
      expect(text.danger).toBe(true);
    });

    it("returns normal launch confirmation text for safe workflows", () => {
      const workflow: WorkflowChoice = {
        id: "w1",
        name: "Preview",
        suggested: true,
        favorite: false,
        dangerous: false,
        group: "main",
      };

      const confirmState: Extract<Flow, { view: "confirm"; kind: "launch" }> = {
        view: "confirm",
        kind: "launch",
        proposalId: "p123",
        title: "Add feature",
        workflow,
      };

      const text = confirmText(confirmState);
      expect(text.question).toBe("¿Lanzar «Add feature» con Preview?");
      expect(text.yes).toBe("Sí, lanzar");
      expect(text.danger).toBe(false);
    });
  });
});

describe("resultText", () => {
  it("returns success text for launched status", () => {
    const result: ApiResult<{ status: string; sessionName?: string }> = {
      ok: true,
      data: { status: "launched", sessionName: "S123ABC" },
    };

    const text = resultText(result);
    expect(text.ok).toBe(true);
    expect(text.text).toBe("✅ Sesión S123ABC creada");
  });

  it("returns success text for rejected status", () => {
    const result: ApiResult<{ status: string; sessionName?: string }> = {
      ok: true,
      data: { status: "rejected" },
    };

    const text = resultText(result);
    expect(text.ok).toBe(true);
    expect(text.text).toBe("❌ Ignorada");
  });

  it("returns error text for launch_failed code", () => {
    const result: ApiResult<{ status: string; sessionName?: string }> = {
      ok: false,
      status: 502,
      code: "launch_failed",
      message: "Daemon unavailable",
    };

    const text = resultText(result);
    expect(text.ok).toBe(false);
    expect(text.text).toBe("⚠️ No se pudo lanzar: Daemon unavailable");
  });

  it("returns error text for not_pending code", () => {
    const result: ApiResult<{ status: string; sessionName?: string }> = {
      ok: false,
      status: 409,
      code: "not_pending",
      message: "Proposal no longer pending",
    };

    const text = resultText(result);
    expect(text.ok).toBe(false);
    expect(text.text).toBe("⚠️ Ya no está vigente");
  });

  it("returns generic error text for other error codes", () => {
    const result: ApiResult<{ status: string; sessionName?: string }> = {
      ok: false,
      status: 400,
      code: "unknown_workflow",
      message: "Workflow not found",
    };

    const text = resultText(result);
    expect(text.ok).toBe(false);
    expect(text.text).toBe("⚠️ Workflow not found");
  });
});
