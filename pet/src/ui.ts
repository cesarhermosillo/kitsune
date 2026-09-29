// Helpers puros de la interfaz de la mascota (main.ts solo cablea DOM/Tauri con ellos).
import { offlineText, summary, visibleBubble, type Model } from "./model";

/** Texto de la burbuja normal (no expandida). Offline gana y oculta el resumen de hover. */
export function bubbleText(m: Model, now: number, hovering: boolean): string {
  if (!m.connected) return offlineText(m) ?? "";
  const b = visibleBubble(m, now);
  if (b) return b.text;
  return hovering ? summary(m.state) : "";
}

/** I6: la burbuja se apoya 8 px sobre el zorro y usa el alto restante de la ventana (con 8 px de margen). */
const TAIL_GAP = 18; // espacio bajo la burbuja para el piquito
const TAIL_HEIGHT = 14; // el piquito arranca justo en el borde inferior de la burbuja

/** Burbuja de diálogo sobre el zorro: su posición, alto máximo y dónde va el piquito que lo señala. */
export function bubbleLayout(frameSize: number, scale: number, windowHeight: number): { bottom: number; maxHeight: number; tailBottom: number; tailRight: number } {
  const size = frameSize * scale;
  const bottom = size + TAIL_GAP;
  return { bottom, maxHeight: Math.max(0, windowHeight - bottom - 8), tailBottom: bottom - TAIL_HEIGHT, tailRight: Math.round(size * 0.3) };
}

/** m2: el canvas solo se redibuja cuando cambia esta clave. */
export const drawKey = (anim: string, frame: number, scale: number, offline: boolean): string =>
  `${anim}|${frame}|${scale}|${offline ? 1 : 0}`;

/**
 * I7: estado de un gesto de clic/arrastre sobre el zorro. `down` siempre reinicia (macOS se come el
 * mouseup tras `startDragging()`, así que un gesto puede quedar sin cerrar). `move` devuelve true una
 * sola vez, cuando hay que arrancar el arrastre. `up` devuelve "toggle" solo para un clic sin arrastre.
 */
export function createGesture(threshold = 3) {
  let active = false;
  let startX = 0;
  let startY = 0;
  const g = {
    dragged: false,
    down(x: number, y: number) {
      active = true;
      g.dragged = false;
      startX = x;
      startY = y;
    },
    move(x: number, y: number): boolean {
      if (!active || g.dragged) return false;
      if (Math.hypot(x - startX, y - startY) <= threshold) return false;
      g.dragged = true;
      return true;
    },
    up(): "toggle" | null {
      if (!active) return null;
      active = false;
      return g.dragged ? null : "toggle";
    },
  };
  return g;
}

/** m1: el menú (Rust) emite el estado explícito de "No molestar". */
export function dndFromMenu(payload: string): boolean | null {
  if (payload === "dnd_on") return true;
  if (payload === "dnd_off") return false;
  return null;
}

/** I1: acción del listener delegado según los data-* del enlace pulsado. */
export function linkAction(data: { kind?: string; url?: string }):
  | { cmd: "open_url"; args: { url: string } }
  | { cmd: "open_ronin" }
  | null {
  if (data.kind === "clickup" && data.url) return { cmd: "open_url", args: { url: data.url } };
  if (data.kind === "ronin") return { cmd: "open_ronin" };
  return null;
}
