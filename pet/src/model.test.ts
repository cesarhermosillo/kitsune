import { describe, test, expect } from "vitest";
import {
  applyEvent,
  applySnapshot,
  computeStatus,
  currentAnimation,
  EMPTY_STATE,
  initialModel,
  setConnected,
  summary,
  visibleBubble,
} from "./model";

const on = (now = 0) =>
  setConnected(initialModel(now), true, now);
const session = (over = {}) => ({
  name: "cowork-a",
  stage: "impl",
  stagesDone: 1,
  stagesTotal: 4,
  needsInput: false,
  ...over,
});

describe("model", () => {
  test("sin conexión es offline aunque haya trabajo", () => {
    const m = applySnapshot(initialModel(0), { ...EMPTY_STATE, sessions: [session()] }, 0);
    expect(computeStatus(m, 0)).toBe("offline");
    expect(currentAnimation(m, 0)).toBe("offline");
  });

  test("prioridad asking > alert > sad > working > sniffing > idle > sleeping", () => {
    let m = on(0);
    expect(computeStatus(m, 0)).toBe("idle");
    expect(computeStatus(m, 600_001)).toBe("sleeping");
    m = applyEvent(m, { type: "triage_started", at: 1, title: "t" }, 1);
    expect(computeStatus(m, 1)).toBe("sniffing");
    m = applyEvent(
      m,
      { type: "session_update", at: 2, name: "cowork-a", stage: "impl", stagesDone: 1, stagesTotal: 4 },
      2
    );
    expect(computeStatus(m, 2)).toBe("working");
    m = applyEvent(m, { type: "error", at: 3, message: "x" }, 3);
    expect(computeStatus(m, 3)).toBe("sad");
    m = applyEvent(m, { type: "proposal_created", at: 4, id: "p1", title: "T", url: "u", repo: "r", workflow: "w" }, 4);
    expect(computeStatus(m, 4)).toBe("alert");
    m = applyEvent(m, { type: "session_question", at: 5, name: "cowork-a", question: "¿Sigo?" }, 5);
    expect(computeStatus(m, 5)).toBe("asking");
  });

  test("sad expira a los 60 s", () => {
    const m = applyEvent(on(0), { type: "error", at: 0, message: "x" }, 0);
    expect(computeStatus(m, 59_999)).toBe("sad");
    expect(computeStatus(m, 60_001)).toBe("idle");
  });

  test("celebrate es puntual y vuelve al estado calculado", () => {
    let m = applyEvent(
      on(0),
      { type: "session_update", at: 0, name: "cowork-a", stage: "done", stagesDone: 4, stagesTotal: 4 },
      0
    );
    m = applyEvent(m, { type: "session_done", at: 1, name: "cowork-a" }, 1);
    expect(currentAnimation(m, 2)).toBe("celebrate");
    expect(currentAnimation(m, 3_002)).toBe("idle");
  });

  test("proposal_resolved quita la propuesta y no duplica ids", () => {
    let m = on(0);
    const created = {
      type: "proposal_created" as const,
      at: 1,
      id: "p1",
      title: "T",
      url: "u",
      repo: "r",
      workflow: "w",
    };
    m = applyEvent(applyEvent(m, created, 1), created, 1);
    expect(m.state.pending).toHaveLength(1);
    m = applyEvent(
      m,
      { type: "proposal_resolved", at: 2, id: "p1", status: "launched", sessionName: "cowork-a" },
      2
    );
    expect(m.state.pending).toHaveLength(0);
  });

  test("proposal_resolved con failed conserva el item marcado como failed; rejected/expired lo quitan", () => {
    let m = on(0);
    const created = (id: string) => ({
      type: "proposal_created" as const,
      at: 1,
      id,
      title: "T",
      url: "u",
      repo: "r",
      workflow: "w",
    });
    m = applyEvent(m, created("p1"), 1);
    m = applyEvent(m, { type: "proposal_resolved", at: 2, id: "p1", status: "failed" }, 2);
    expect(m.state.pending).toEqual([
      { id: "p1", title: "T", url: "u", repo: "r", workflow: "w", createdAt: 1, status: "failed" },
    ]);

    m = applyEvent(m, created("p2"), 3);
    m = applyEvent(m, { type: "proposal_resolved", at: 4, id: "p2", status: "rejected" }, 4);
    expect(m.state.pending.some((p) => p.id === "p2")).toBe(false);

    m = applyEvent(m, created("p3"), 5);
    m = applyEvent(m, { type: "proposal_resolved", at: 6, id: "p3", status: "expired" }, 6);
    expect(m.state.pending.some((p) => p.id === "p3")).toBe(false);
  });

  test("burbujas: nueva tarea dura 6 s; la pregunta es fija, acotada a 140 y se quita con session_update", () => {
    let m = applyEvent(on(0), { type: "proposal_created", at: 0, id: "p1", title: "Permisos", url: "u", repo: "r", workflow: "w" }, 0);
    expect(visibleBubble(m, 1)?.text).toBe("Nueva tarea: Permisos");
    expect(visibleBubble(m, 6_001)).toBeNull();
    m = applyEvent(m, { type: "session_question", at: 10, name: "cowork-a", question: "x".repeat(300) }, 10);
    const b = visibleBubble(m, 100_000)!;
    expect(b.sticky).toBe(true);
    expect(b.text.length).toBeLessThanOrEqual("cowork-a pregunta: ".length + 140);
    m = applyEvent(m, { type: "session_update", at: 11, name: "cowork-a", stage: "tests", stagesDone: 3, stagesTotal: 4 }, 11);
    expect(visibleBubble(m, 12)).toBeNull();
  });

  test("no molestar: duerme y no muestra burbujas", () => {
    let m = { ...on(0), dnd: true };
    m = applyEvent(m, { type: "proposal_created", at: 0, id: "p1", title: "T", url: "u", repo: "r", workflow: "w" }, 0);
    expect(computeStatus(m, 1)).toBe("sleeping");
    expect(visibleBubble(m, 1)).toBeNull();
  });

  test("summary en español con singular y plural", () => {
    expect(summary(EMPTY_STATE)).toBe("Todo tranquilo");
    expect(
      summary({
        ...EMPTY_STATE,
        sessions: [session(), session({ name: "b" })],
        pending: [{ id: "p", title: "", url: "", repo: "", workflow: "", createdAt: 0, status: "pending" }],
      })
    ).toBe("2 sesiones trabajando · 1 propuesta pendiente");
  });
});
