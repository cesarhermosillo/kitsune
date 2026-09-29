import { describe, test, expect } from "vitest";
import { applyEvent, applySnapshot, EMPTY_STATE, initialModel, offlineText, setConnected } from "./model";

const on = (now = 0) => setConnected(initialModel(now), true, now);
const ask = (m: ReturnType<typeof on>) =>
  applyEvent(m, { type: "session_question", at: 1, name: "cowork-a", question: "¿Sigo?" }, 1);

describe("I3: snapshot reconcilia la burbuja fija", () => {
  test("se descarta si la sesión ya no pregunta", () => {
    const m = applySnapshot(ask(on()), {
      ...EMPTY_STATE,
      sessions: [{ name: "cowork-a", stage: "x", stagesDone: 1, stagesTotal: 2, needsInput: false }],
    }, 2);
    expect(m.bubble).toBeNull();
  });

  test("se descarta si la sesión ya no existe", () => {
    expect(applySnapshot(ask(on()), EMPTY_STATE, 2).bubble).toBeNull();
  });

  test("se conserva si la sesión sigue preguntando", () => {
    const m = applySnapshot(ask(on()), {
      ...EMPTY_STATE,
      sessions: [{ name: "cowork-a", stage: "x", stagesDone: 1, stagesTotal: 2, needsInput: true, question: "¿Sigo?" }],
    }, 2);
    expect(m.bubble?.sticky).toBe(true);
  });

  test("una burbuja no fija no se toca", () => {
    const m0 = applyEvent(on(), { type: "triage_started", at: 1, title: "t" }, 1);
    expect(applySnapshot(m0, EMPTY_STATE, 2).bubble?.text).toBe("Revisando…");
  });
});

describe("I5: motivo de desconexión", () => {
  test("antes del primer intento no hay burbuja offline", () => {
    expect(offlineText(initialModel(0))).toBeNull();
  });

  test("sin conexión y sin motivo de token: 'Kitsune no está corriendo'", () => {
    const m = setConnected(on(), false, 5, "TypeError: Load failed");
    expect(m.offlineReason).toBe("TypeError: Load failed");
    expect(offlineText(m)).toBe("Kitsune no está corriendo");
    expect(offlineText(setConnected(on(), false, 5))).toBe("Kitsune no está corriendo");
  });

  test("si el motivo habla del token, la burbuja muestra el motivo", () => {
    const reason = "No encuentro ~/.kitsune/pet-token (¿Kitsune está corriendo?)";
    expect(offlineText(setConnected(on(), false, 5, reason))).toBe(reason);
  });

  test("al reconectar se limpia el motivo", () => {
    const m = setConnected(setConnected(on(), false, 5, "x"), true, 6);
    expect(m.offlineReason).toBeNull();
    expect(offlineText(m)).toBeNull();
  });
});
