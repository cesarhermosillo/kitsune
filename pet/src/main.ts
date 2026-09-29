import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import meta from "../public/sprites.json";
import type { ApiDeps } from "./api";
import { getOptions, launchProposal, rejectProposal, retryProposal } from "./api";
import { startClient } from "./client";
import { expandedRows } from "./expanded";
import { choiceLabel, confirmText, flowReducer, LIST, resultText, visibleChoices, type Flow } from "./flow";
import { isOpaqueAt } from "./hit";
import { applyEvent, applySnapshot, currentAnimation, initialModel, setConnected, summary, type Model } from "./model";
import { frameIndex } from "./player";
import type { PetState } from "./types";
import { bubbleLayout, bubbleText, createGesture, dndFromMenu, drawKey, linkAction } from "./ui";

// El puerto debe coincidir con localApi.port del daemon y con connect-src de la CSP (tauri.conf.json).
const API = "http://127.0.0.1:47823";
const canvas = document.getElementById("pet") as HTMLCanvasElement;
const bubbleEl = document.getElementById("bubble") as HTMLDivElement;
const tailEl = document.getElementById("bubble-tail") as HTMLDivElement;
const ctx = canvas.getContext("2d")!;
const apiDeps: ApiDeps = {
  baseUrl: API,
  token: () => invoke<string>("read_pet_token"),
  fetch: window.fetch.bind(window),
};
let scale = Number(localStorage.getItem("kitsune-scale") ?? 4);
let model: Model = initialModel(Date.now());
let hovering = false;
let expanded = false;
let animName = "";
let animStart = 0;

// Task 6: estado local del flujo de acciones (lanzar/ignorar/reintentar con confirmación).
// Cambiar `flow` marca la burbuja como sucia; nunca reconstruye el DOM fuera de draw().
let flow: Flow = LIST;
let bubbleDirty = true;
let resultTimer: ReturnType<typeof setTimeout> | undefined;

function setFlow(next: Flow) {
  flow = next;
  bubbleDirty = true;
  clearTimeout(resultTimer);
  if (next.view === "result") {
    resultTimer = setTimeout(() => setFlow(LIST), 4000);
  }
}

function closeBubble() {
  clearTimeout(resultTimer);
  flow = LIST;
  bubbleDirty = true;
  expanded = false;
}

// m1: "No molestar" persiste entre arranques; el estado de verdad del menú vive en Rust.
const savedDnd = localStorage.getItem("kitsune-dnd") === "1";
model = { ...model, dnd: savedDnd };
void invoke("set_dnd", { on: savedDnd }).catch(() => {});

function resize() {
  canvas.width = canvas.height = meta.frameSize * scale;
  ctx.imageSmoothingEnabled = false;
  // I6: la burbuja se apoya sobre el zorro según la escala y hace scroll si no cabe.
  const { bottom, maxHeight, tailBottom, tailRight } = bubbleLayout(meta.frameSize, scale, window.innerHeight);
  bubbleEl.style.bottom = `${bottom}px`;
  bubbleEl.style.maxHeight = `${maxHeight}px`;
  tailEl.style.bottom = `${tailBottom}px`;
  tailEl.style.right = `${tailRight}px`;
}
resize();
window.addEventListener("resize", resize);

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
  const index = frameIndex(anim, animStart, now);
  return { current, name, index, frame: anim.frames[index] };
}

let lastDrawKey = "";
let lastBubbleText: string | null = null;
let renderedExpandedState: PetState | null = null;

function draw() {
  const now = Date.now();
  const { current, name, index, frame } = currentFrame(now);
  const offline = current === "offline";
  // m2: solo se redibuja el canvas cuando cambia el cuadro, la animación, la escala u offline.
  const key = drawKey(name, index, scale, offline);
  if (key !== lastDrawKey) {
    lastDrawKey = key;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = offline ? 0.5 : 1;
    ctx.filter = offline ? "grayscale(1)" : "none";
    ctx.drawImage(sheet, frame.x, frame.y, meta.frameSize, meta.frameSize, 0, 0, canvas.width, canvas.height);
  }
  // I1: el DOM de la burbuja solo se toca cuando cambia algo, para no desprender el <a> ni los
  // <button> entre mousedown y mouseup. Task 6: además de dirty por cambios de `flow`, la vista
  // "list" también se repinta cuando cambia model.state (nuevas propuestas/sesiones).
  if (expanded && model.connected) {
    const stateChanged = flow.view === "list" && renderedExpandedState !== model.state;
    if (bubbleDirty || stateChanged) {
      renderedExpandedState = model.state;
      bubbleDirty = false;
      lastBubbleText = null;
      renderExpandedBubble();
    }
    bubbleEl.classList.add("show");
  } else {
    renderedExpandedState = null;
    const text = bubbleText(model, now, hovering);
    if (text !== lastBubbleText) {
      lastBubbleText = text;
      bubbleEl.textContent = text;
      bubbleEl.classList.toggle("show", text.length > 0);
    }
  }
  requestAnimationFrame(draw);
}

// Botón genérico de la burbuja (Task 6). Siempre textContent, nunca innerHTML.
function makeButton(label: string, dataset: Record<string, string>, danger = false): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  for (const [k, v] of Object.entries(dataset)) btn.dataset[k] = v;
  if (danger) btn.classList.add("danger");
  btn.textContent = label;
  return btn;
}

// Spec §4 + Task 6: "Clic: burbuja expandida con la lista de pendientes, los enlaces
// a ClickUp y Ronin, y los botones para lanzar/ignorar/reintentar." Built as DOM nodes
// (never innerHTML with remote strings) so the ClickUp titles/urls from the daemon
// can't inject markup.
function renderExpandedBubble() {
  bubbleEl.textContent = "";
  switch (flow.view) {
    case "list":
      renderListView();
      break;
    case "choose":
      renderChooseView(flow);
      break;
    case "confirm":
      renderConfirmView(flow);
      break;
    case "busy":
      renderBusyView(flow);
      break;
    case "result":
      renderResultView(flow);
      break;
  }
}

function renderListView() {
  const summaryLine = document.createElement("div");
  summaryLine.textContent = summary(model.state);
  bubbleEl.appendChild(summaryLine);
  for (const row of expandedRows(model.state)) {
    const line = document.createElement("div");
    line.textContent = `• ${row.label} `;
    const link = document.createElement("a");
    link.href = "#";
    link.dataset.kind = row.kind;
    if (row.url) link.dataset.url = row.url;
    link.textContent = row.kind === "clickup" ? "Abrir en ClickUp" : "Ver en Ronin";
    line.appendChild(link);
    bubbleEl.appendChild(line);

    if (row.kind === "clickup" && row.proposalId) {
      const actions = document.createElement("div");
      actions.className = "row";
      if (row.status === "failed") {
        actions.appendChild(makeButton("🔁 Reintentar", { act: "retry", id: row.proposalId }));
      } else {
        actions.appendChild(makeButton("🚀 Lanzar…", { act: "launch-open", id: row.proposalId }));
      }
      actions.appendChild(makeButton("❌ Ignorar", { act: "reject-ask", id: row.proposalId }));
      bubbleEl.appendChild(actions);
    }
  }
}

function renderChooseView(f: Extract<Flow, { view: "choose" }>) {
  const title = document.createElement("div");
  title.textContent = f.title;
  bubbleEl.appendChild(title);
  const visible = visibleChoices(f);
  const row = document.createElement("div");
  row.className = "row";
  for (const choice of visible) {
    row.appendChild(makeButton(choiceLabel(choice), { act: "pick", wf: choice.id }));
  }
  if (visible.length < f.choices.length) {
    row.appendChild(makeButton("Otro…", { act: "other" }));
  }
  row.appendChild(makeButton("Cancelar", { act: "cancel" }));
  bubbleEl.appendChild(row);
}

function renderConfirmView(f: Extract<Flow, { view: "confirm" }>) {
  const { question, yes, danger } = confirmText(f);
  const q = document.createElement("div");
  q.textContent = question;
  bubbleEl.appendChild(q);
  const row = document.createElement("div");
  row.className = "row";
  row.appendChild(makeButton(yes, { act: "confirm" }, danger));
  row.appendChild(makeButton("Cancelar", { act: "cancel" }));
  bubbleEl.appendChild(row);
}

function renderBusyView(f: Extract<Flow, { view: "busy" }>) {
  const p = document.createElement("div");
  p.textContent = f.label;
  bubbleEl.appendChild(p);
}

function renderResultView(f: Extract<Flow, { view: "result" }>) {
  const p = document.createElement("div");
  p.textContent = f.text;
  bubbleEl.appendChild(p);
}

// Task 6: dispara la llamada a la API correspondiente a un botón de la burbuja y
// avanza `flow` con flowReducer en cada paso (busy → resultado).
function finish(r: any) {
  const rt = resultText(r);
  setFlow(flowReducer(flow, { type: "done", ok: rt.ok, text: rt.text }));
}

async function handleFlowAction(act: string, ds: DOMStringMap) {
  switch (act) {
    case "launch-open": {
      if (flow.view !== "list") return;
      const id = ds.id;
      if (!id) return;
      setFlow(flowReducer(flow, { type: "busy", label: "Cargando workflows…" }));
      const r = await getOptions(apiDeps, id);
      if (r.ok) {
        setFlow(
          flowReducer(flow, {
            type: "open_choose",
            proposalId: id,
            title: r.data.title,
            choices: r.data.choices,
          })
        );
      } else {
        finish(r);
      }
      break;
    }
    case "reject-ask": {
      const id = ds.id;
      if (!id) return;
      const title = model.state.pending.find((p) => p.id === id)?.title ?? "";
      setFlow(flowReducer(flow, { type: "ask_reject", proposalId: id, title }));
      break;
    }
    case "retry": {
      if (flow.view !== "list") return;
      const id = ds.id;
      if (!id) return;
      setFlow(flowReducer(flow, { type: "busy", label: "Lanzando…" }));
      const r = await retryProposal(apiDeps, id);
      finish(r);
      break;
    }
    case "other":
      setFlow(flowReducer(flow, { type: "show_other" }));
      break;
    case "pick":
      setFlow(flowReducer(flow, { type: "pick", workflowId: ds.wf ?? "" }));
      break;
    case "cancel":
      setFlow(flowReducer(flow, { type: "cancel" }));
      break;
    case "confirm": {
      if (flow.view !== "confirm") return;
      const current = flow;
      if (current.kind === "launch") {
        setFlow(flowReducer(flow, { type: "busy", label: "Lanzando…" }));
        const r = await launchProposal(apiDeps, current.proposalId, current.workflow.id);
        finish(r);
      } else {
        setFlow(flowReducer(flow, { type: "busy", label: "Ignorando…" }));
        const r = await rejectProposal(apiDeps, current.proposalId);
        finish(r);
      }
      break;
    }
  }
}

// I1: un solo listener delegado para los enlaces y botones de la burbuja expandida.
bubbleEl.addEventListener("click", (e) => {
  const target = e.target as Element | null;
  const link = target?.closest?.("a[data-kind]") as HTMLAnchorElement | null;
  if (link) {
    e.preventDefault();
    const action = linkAction({ kind: link.dataset.kind, url: link.dataset.url });
    if (action?.cmd === "open_url") void invoke("open_url", action.args);
    else if (action?.cmd === "open_ronin") void invoke("open_ronin");
    return;
  }
  const btn = target?.closest?.("[data-act]") as HTMLElement | null;
  if (!btn) return;
  e.preventDefault();
  void handleFlowAction(btn.dataset.act ?? "", btn.dataset);
});

// Los clics atraviesan la ventana salvo sobre píxeles opacos del zorro o sobre la burbuja visible.
// I4: null = desconocido, así que el primer sondeo siempre envía el estado; además se fija ignore al arrancar.
let ignoring: boolean | null = null;
void invoke("set_click_through", { ignore: true }).then(() => { ignoring ??= true; }).catch(() => {});
// m2: sin sondeo mientras la ventana está oculta y sin solapar ticks.
let windowVisible = true;
let polling = false;
setInterval(async () => {
  if (polling || !windowVisible || document.hidden) return;
  polling = true;
  try {
    const pos = await invoke<[number, number] | null>("cursor_in_window").catch(() => null);
    const rect = canvas.getBoundingClientRect();
    const { frame } = currentFrame(Date.now());
    const overPet = !!pos && isOpaqueAt(alphaAt, frame, meta.frameSize, scale, pos[0] - rect.left, pos[1] - rect.top);
    const b = bubbleEl.getBoundingClientRect();
    const overBubble = !!pos && bubbleEl.classList.contains("show") && pos[0] >= b.left && pos[0] <= b.right && pos[1] >= b.top && pos[1] <= b.bottom;
    hovering = overPet;
    const ignore = !(overPet || overBubble);
    if (ignore !== ignoring) { ignoring = ignore; await invoke("set_click_through", { ignore }).catch(() => { ignoring = null; }); }
  } finally {
    polling = false;
  }
}, 33);

// I7: tras startDragging() macOS se come el mouseup, así que cada mousedown limpia los listeners
// del gesto anterior y la animación de caída sale de onMoved (150 ms después del último movimiento).
const gesture = createGesture();
let cleanupGesture: (() => void) | null = null;
let dropPending = false;
let dropTimer: ReturnType<typeof setTimeout> | undefined;
canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  cleanupGesture?.();
  gesture.down(e.screenX, e.screenY);
  const onMove = (m: MouseEvent) => {
    if (gesture.move(m.screenX, m.screenY)) { dropPending = true; void getCurrentWindow().startDragging(); }
  };
  const onUp = () => {
    cleanupGesture?.();
    if (gesture.up() === "toggle") {
      // Task 6: al cerrar la burbuja, el flujo vuelve siempre a la lista.
      if (expanded) closeBubble();
      else { expanded = true; bubbleDirty = true; }
    }
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  cleanupGesture = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    cleanupGesture = null;
  };
});
void getCurrentWindow().onMoved(() => {
  if (!dropPending) return;
  clearTimeout(dropTimer);
  dropTimer = setTimeout(() => {
    dropPending = false;
    cleanupGesture?.();
    canvas.animate([{ transform: "scaleY(0.85)" }, { transform: "scaleY(1)" }], { duration: 180 });
  }, 150);
});
canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); void invoke("show_context_menu"); });

void listen<string>("pet-menu", ({ payload }) => {
  const dnd = dndFromMenu(payload);
  if (dnd !== null) { model = { ...model, dnd }; localStorage.setItem("kitsune-dnd", dnd ? "1" : "0"); }
  if (payload.startsWith("size_")) { scale = Number(payload.slice(5)); localStorage.setItem("kitsune-scale", String(scale)); resize(); }
});
void listen<boolean>("pet-visible", ({ payload }) => { windowVisible = payload; });

startClient({
  baseUrl: API,
  token: () => invoke<string>("read_pet_token"),
  fetch: window.fetch.bind(window),
  onSnapshot: (s) => { model = applySnapshot(model, s, Date.now()); },
  onEvent: (e) => { model = applyEvent(model, e, Date.now()); },
  onConnected: (c, reason) => { model = setConnected(model, c, Date.now(), reason); },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
});
