import type { InboxEvent } from "../types.js";

export type Fetch = typeof fetch;
export class ClickUpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface ClickUpConnector { poll(since: number): Promise<{ events: InboxEvent[]; nextCursor: number }> }

const API = "https://api.clickup.com/api/v2";
const MAX_BODY = 4000;

interface CuUser { id: number; username?: string }
interface CuTask {
  id: string; name: string; description?: string; url: string; date_updated: string;
  assignees?: CuUser[]; tags?: Array<{ name: string }>; list?: { id: string; name: string }; creator?: CuUser;
}
interface CuComment { id: string; comment_text?: string; comment?: Array<{ type?: string; text?: string; user?: CuUser }>; user?: CuUser; date: string }

export function createClickUpConnector(opts: { token: string; listIds: string[]; fetch: Fetch; now: () => number; timeoutMs?: number }): ClickUpConnector {
  let me: number | null = null;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  async function get<T>(path: string): Promise<T> {
    const where = path.split("?")[0];
    // Errores de red y timeouts salen como ClickUpError con status 0.
    const network = (error: unknown) => new ClickUpError(0, error instanceof Error && error.name === "TimeoutError"
      ? `ClickUp no respondió en ${timeoutMs / 1000} s en ${where}`
      : `ClickUp no responde en ${where}: ${error instanceof Error ? error.message : "error de red"}`);
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try { response = await opts.fetch(`${API}${path}`, { headers: { Authorization: opts.token }, signal }); }
    catch (error) { throw network(error); }
    if (!response.ok) throw new ClickUpError(response.status, `ClickUp respondió ${response.status} en ${where}`);
    try { return (await response.json()) as T; } catch (error) { throw network(error); }
  }

  async function myId(): Promise<number> {
    if (me === null) me = (await get<{ user: CuUser }>("/user")).user.id;
    return me;
  }

  const meta = (t: CuTask) => ({ taskId: t.id, listId: t.list?.id ?? "", listName: t.list?.name ?? "", tags: (t.tags ?? []).map((tag) => tag.name) });
  const clip = (text: string) => text.slice(0, MAX_BODY);

  return {
    async poll(since) {
      const self = await myId();
      const events: InboxEvent[] = [];
      let nextCursor = since;
      for (const listId of opts.listIds) {
        const { tasks } = await get<{ tasks: CuTask[] }>(`/list/${encodeURIComponent(listId)}/task?date_updated_gt=${since}&subtasks=true&include_closed=false`);
        for (const t of tasks) {
          nextCursor = Math.max(nextCursor, Number(t.date_updated) || 0);
          const mine = (t.assignees ?? []).some((a) => a.id === self);
          if (mine) {
            events.push({
              source: "clickup", id: `task_assigned:${t.id}`, kind: "task_assigned",
              title: t.name, body: clip(t.description ?? ""), url: t.url,
              author: t.creator?.username ?? "", at: new Date(Number(t.date_updated) || opts.now()).toISOString(), meta: meta(t),
            });
          }
          const { comments } = await get<{ comments: CuComment[] }>(`/task/${encodeURIComponent(t.id)}/comment`);
          for (const c of comments) {
            if (Number(c.date) <= since || c.user?.id === self) continue;
            const tagsMe = (c.comment ?? []).some((part) => part.type === "tag" && part.user?.id === self);
            const kind = tagsMe ? "mention" : mine ? "comment" : null;
            if (!kind) continue;
            events.push({
              source: "clickup", id: `${kind}:${t.id}:${c.id}`, kind,
              title: t.name, body: clip(c.comment_text ?? ""), url: t.url,
              author: c.user?.username ?? "", at: new Date(Number(c.date)).toISOString(), meta: meta(t),
            });
          }
        }
      }
      return { events, nextCursor };
    },
  };
}
