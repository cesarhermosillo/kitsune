import { describe, test, expect } from "vitest";
import { applyEvent, initialModel, setConnected } from "./model";
import { bubbleLayout, bubbleText, createGesture, dndFromMenu, drawKey, linkAction } from "./ui";

const on = () => setConnected(initialModel(0), true, 0);

describe("bubbleText", () => {
  test("offline: muestra el motivo/aviso y nunca el resumen al pasar el mouse", () => {
    const off = setConnected(on(), false, 1, "fetch failed");
    expect(bubbleText(off, 1, true)).toBe("Kitsune no está corriendo");
    expect(bubbleText(setConnected(on(), false, 1, "sin pet-token"), 1, false)).toBe("sin pet-token");
  });
  test("antes del primer intento no hay burbuja ni resumen", () => {
    expect(bubbleText(initialModel(0), 0, true)).toBe("");
  });
  test("conectado: burbuja activa, si no el resumen al pasar el mouse", () => {
    const m = applyEvent(on(), { type: "triage_started", at: 1, title: "t" }, 1);
    expect(bubbleText(m, 2, false)).toBe("Revisando…");
    expect(bubbleText(on(), 0, true)).toBe("Todo tranquilo");
    expect(bubbleText(on(), 0, false)).toBe("");
  });
});

describe("bubbleLayout (I6)", () => {
  test("la burbuja deja espacio para el piquito y ocupa el espacio restante", () => {
    expect(bubbleLayout(32, 4, 300)).toEqual({ bottom: 146, maxHeight: 146, tailBottom: 132, tailRight: 38 });
    expect(bubbleLayout(32, 2, 300)).toEqual({ bottom: 82, maxHeight: 210, tailBottom: 68, tailRight: 19 });
  });
  test("nunca devuelve una altura negativa", () => {
    expect(bubbleLayout(32, 4, 100).maxHeight).toBe(0);
  });
});

describe("drawKey (m2)", () => {
  test("cambia solo si cambia cuadro, animación, escala u offline", () => {
    const k = drawKey("idle", 1, 4, false);
    expect(drawKey("idle", 1, 4, false)).toBe(k);
    expect(drawKey("idle", 2, 4, false)).not.toBe(k);
    expect(drawKey("working", 1, 4, false)).not.toBe(k);
    expect(drawKey("idle", 1, 3, false)).not.toBe(k);
    expect(drawKey("idle", 1, 4, true)).not.toBe(k);
  });
});

describe("createGesture (I7)", () => {
  test("un clic sin mover alterna una vez", () => {
    const g = createGesture();
    g.down(0, 0);
    expect(g.move(1, 1)).toBe(false);
    expect(g.up()).toBe("toggle");
    expect(g.up()).toBeNull();
  });
  test("mover más de 3 px arranca el arrastre una sola vez y no alterna", () => {
    const g = createGesture();
    g.down(0, 0);
    expect(g.move(5, 0)).toBe(true);
    expect(g.move(10, 0)).toBe(false);
    expect(g.dragged).toBe(true);
    expect(g.up()).toBeNull();
  });
  test("si macOS se come el mouseup del arrastre, el siguiente clic alterna una sola vez", () => {
    const g = createGesture();
    g.down(0, 0);
    g.move(20, 0); // arrastre: no llega mouseup
    g.down(0, 0); // nuevo gesto: reinicia
    expect(g.up()).toBe("toggle");
    expect(g.up()).toBeNull();
  });
});

describe("dndFromMenu (m1)", () => {
  test("interpreta dnd_on/dnd_off y descarta el resto", () => {
    expect(dndFromMenu("dnd_on")).toBe(true);
    expect(dndFromMenu("dnd_off")).toBe(false);
    expect(dndFromMenu("size_2")).toBeNull();
  });
});

describe("linkAction (I1)", () => {
  test("lee data-kind/data-url del enlace delegado", () => {
    expect(linkAction({ kind: "clickup", url: "https://x" })).toEqual({ cmd: "open_url", args: { url: "https://x" } });
    expect(linkAction({ kind: "ronin" })).toEqual({ cmd: "open_ronin" });
    expect(linkAction({ kind: "clickup" })).toBeNull();
    expect(linkAction({})).toBeNull();
  });
});
