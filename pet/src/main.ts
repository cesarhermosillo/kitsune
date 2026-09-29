import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import meta from "../public/sprites.json";
import { startClient } from "./client";
import { expandedRows } from "./expanded";
import { isOpaqueAt } from "./hit";
import { applyEvent, applySnapshot, currentAnimation, initialModel, setConnected, summary, visibleBubble, type Model } from "./model";
import { frameIndex } from "./player";

const API = "http://127.0.0.1:47823";
const canvas = document.getElementById("pet") as HTMLCanvasElement;
const bubbleEl = document.getElementById("bubble") as HTMLDivElement;
const ctx = canvas.getContext("2d")!;
let scale = Number(localStorage.getItem("kitsune-scale") ?? 4);
let model: Model = initialModel(Date.now());
let hovering = false;
let expanded = false;
let animName = "";
let animStart = 0;

function resize() {
  canvas.width = canvas.height = meta.frameSize * scale;
  ctx.imageSmoothingEnabled = false;
}
resize();

const sheet = new Image();
sheet.src = "/sprites.png";
let alphaData: ImageData | null = null;
sheet.onload = () => {
  const off = new OffscreenCanvas(sheet.width, sheet.height);
  const octx = off.getContext("2d")!;
  octx.drawImage(sheet, 0, 0);
  alphaData = octx.getImageData(0, 0, sheet.width, sheet.height);
  requestAnimationFrame(draw);
};
const alphaAt = (x: number, y: number) => (alphaData ? alphaData.data[(y * alphaData.width + x) * 4 + 3] : 0);

function currentFrame(now: number) {
  const current = currentAnimation(model, now);
  const name = current === "offline" ? "idle" : current;
  if (name !== animName) { animName = name; animStart = now; }
  const anim = (meta.animations as Record<string, { fps: number; loop: boolean; frames: Array<{ x: number; y: number }> }>)[name];
  return { current, frame: anim.frames[frameIndex(anim, animStart, now)] };
}

function draw() {
  const now = Date.now();
  const { current, frame } = currentFrame(now);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = current === "offline" ? 0.5 : 1;
  ctx.filter = current === "offline" ? "grayscale(1)" : "none";
  ctx.drawImage(sheet, frame.x, frame.y, meta.frameSize, meta.frameSize, 0, 0, canvas.width, canvas.height);
  const bubble = visibleBubble(model, now);
  if (expanded) {
    renderExpandedBubble();
    bubbleEl.classList.add("show");
  } else {
    const text = bubble?.text ?? (hovering ? summary(model.state) : "");
    bubbleEl.textContent = text;
    bubbleEl.classList.toggle("show", text.length > 0);
  }
  requestAnimationFrame(draw);
}

// Spec §4: "Clic: burbuja expandida con la lista de pendientes y los enlaces
// a ClickUp y Ronin." Built as DOM nodes (never innerHTML with remote
// strings) so the ClickUp titles/urls from the daemon can't inject markup.
function renderExpandedBubble() {
  bubbleEl.textContent = "";
  const summaryLine = document.createElement("div");
  summaryLine.textContent = summary(model.state);
  bubbleEl.appendChild(summaryLine);
  for (const row of expandedRows(model.state)) {
    const line = document.createElement("div");
    line.textContent = `• ${row.label} `;
    const link = document.createElement("a");
    link.href = "#";
    if (row.kind === "clickup") {
      link.textContent = "Abrir en ClickUp";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        void invoke("open_url", { url: row.url });
      });
    } else {
      link.textContent = "Ver en Ronin";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        void invoke("open_ronin");
      });
    }
    line.appendChild(link);
    bubbleEl.appendChild(line);
  }
}

// Los clics atraviesan la ventana salvo sobre píxeles opacos del zorro o sobre la burbuja visible.
let ignoring = true;
setInterval(async () => {
  const pos = await invoke<[number, number] | null>("cursor_in_window").catch(() => null);
  const rect = canvas.getBoundingClientRect();
  const { frame } = currentFrame(Date.now());
  const overPet = !!pos && isOpaqueAt(alphaAt, frame, meta.frameSize, scale, pos[0] - rect.left, pos[1] - rect.top);
  const b = bubbleEl.getBoundingClientRect();
  const overBubble = !!pos && bubbleEl.classList.contains("show") && pos[0] >= b.left && pos[0] <= b.right && pos[1] >= b.top && pos[1] <= b.bottom;
  hovering = overPet;
  const ignore = !(overPet || overBubble);
  if (ignore !== ignoring) { ignoring = ignore; await invoke("set_click_through", { ignore }); }
}, 33);

let dragged = false;
canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  dragged = false;
  const startX = e.screenX, startY = e.screenY;
  const onMove = (m: MouseEvent) => {
    if (!dragged && Math.hypot(m.screenX - startX, m.screenY - startY) > 3) { dragged = true; getCurrentWindow().startDragging(); }
  };
  window.addEventListener("mousemove", onMove, { once: false });
  window.addEventListener("mouseup", () => {
    window.removeEventListener("mousemove", onMove);
    if (dragged) { canvas.animate([{ transform: "scaleY(0.85)" }, { transform: "scaleY(1)" }], { duration: 180 }); }
    else expanded = !expanded;
  }, { once: true });
});
canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); void invoke("show_context_menu"); });

void listen<string>("pet-menu", ({ payload }) => {
  if (payload === "dnd") model = { ...model, dnd: !model.dnd };
  if (payload.startsWith("size_")) { scale = Number(payload.slice(5)); localStorage.setItem("kitsune-scale", String(scale)); resize(); }
});

startClient({
  baseUrl: API,
  token: () => invoke<string>("read_pet_token"),
  fetch: window.fetch.bind(window),
  onSnapshot: (s) => { model = applySnapshot(model, s, Date.now()); },
  onEvent: (e) => { model = applyEvent(model, e, Date.now()); },
  onConnected: (c) => { model = setConnected(model, c, Date.now()); },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
});
