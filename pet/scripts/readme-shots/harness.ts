// README screenshot harness: boots the real pet (src/main.ts) against the fake daemon, then
// clicks through the bubble flow up to the step named in `?shot=`.
import "./fake-daemon";
import "../../src/main";

type Shot = "collapsed" | "expanded" | "choose" | "confirm" | "result";
const shot = (new URLSearchParams(location.search).get("shot") ?? "collapsed") as Shot;
const steps: Shot[] = ["collapsed", "expanded", "choose", "confirm", "result"];
const upTo = steps.indexOf(shot);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bubble = () => document.getElementById("bubble")!;
const click = (selector: string) => (bubble().querySelector(selector) as HTMLElement | null)?.click();

function toggleBubble() {
  const canvas = document.getElementById("pet")!;
  canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0, screenX: 10, screenY: 10, bubbles: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0, screenX: 10, screenY: 10 }));
}

const spritesLoaded = () =>
  new Promise<void>((resolve) => { const img = new Image(); img.onload = img.onerror = () => resolve(); img.src = "/sprites.png"; });

async function run() {
  await spritesLoaded();
  await wait(400); // conectado al daemon falso y la burbuja de "Nueva tarea" visible
  if (upTo >= 1) { toggleBubble(); await wait(150); }
  if (upTo >= 2) { click('[data-act="launch-open"]'); await wait(200); }
  if (upTo >= 3) { click('[data-act="pick"][data-wf="pr-review-merge-dev"]'); await wait(150); }
  if (upTo >= 4) { click('[data-act="confirm"]'); await wait(200); }
  document.documentElement.dataset.shotReady = "1";
}
void run();
