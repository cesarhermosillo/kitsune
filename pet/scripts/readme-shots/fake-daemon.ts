// Fake Kitsune daemon for the README screenshots: replaces window.fetch before the pet boots.
// All content is invented (generic task titles, acme-* repos).
import type { WorkflowChoice } from "../../src/api";
import type { KitsuneEvent, PetState } from "../../src/types";

const now = Date.now();

export const FAKE_STATE: PetState = {
  triaging: false,
  pending: [
    { id: "a1b2c3d4e5", title: "Add retry to CSV import", url: "https://example.com/tasks/1", repo: "acme-api", workflow: "claude-plan-codex-impl", createdAt: now, status: "pending" },
    { id: "f6g7h8i9j0", title: "Fix flaky login test", url: "https://example.com/tasks/2", repo: "acme-web", workflow: "tmux-worker-loop", createdAt: now, status: "failed" },
  ],
  sessions: [],
  lastError: null,
};

const CHOICES: WorkflowChoice[] = [
  { id: "claude-plan-codex-impl", name: "claude-plan-codex-impl", suggested: true, favorite: true, dangerous: false, group: "main" },
  { id: "pr-review-merge-dev", name: "pr-review-merge-dev", suggested: false, favorite: true, dangerous: true, group: "main" },
  { id: "hotfix-verificado", name: "hotfix-verificado", suggested: false, favorite: false, dangerous: true, group: "other" },
  { id: "tmux-worker-loop", name: "tmux-worker-loop", suggested: false, favorite: false, dangerous: false, group: "other" },
];

const NEW_PROPOSAL: KitsuneEvent = {
  type: "proposal_created", at: now, id: FAKE_STATE.pending[0].id, title: FAKE_STATE.pending[0].title,
  url: FAKE_STATE.pending[0].url, repo: "acme-api", workflow: "claude-plan-codex-impl",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function events(): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(enc.encode(`data: ${JSON.stringify(NEW_PROPOSAL)}\n\n`));
      // The stream stays open, like the real SSE endpoint.
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
  const method = init?.method ?? "GET";
  if (path === "/state") return json(FAKE_STATE);
  if (path === "/events") return events();
  if (path.endsWith("/options")) return json({ title: FAKE_STATE.pending[0].title, choices: CHOICES });
  if (method === "POST" && (path.endsWith("/launch") || path.endsWith("/retry")))
    return json({ status: "launched", sessionName: "acme-api-csv-retry" });
  if (method === "POST" && path.endsWith("/reject")) return json({ status: "rejected" });
  return json({ code: "not_found", message: "not found" }, 404);
};

try {
  localStorage.setItem("kitsune-scale", "3");
  localStorage.setItem("kitsune-dnd", "0");
} catch {
  /* sin storage: el pet usa sus valores por defecto */
}
