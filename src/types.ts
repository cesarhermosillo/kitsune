export type InboxKind = "task_assigned" | "mention" | "comment";
export interface InboxEvent {
  source: "clickup"; id: string; kind: InboxKind;
  title: string; body: string; url: string; author: string; at: string;
  meta: { taskId: string; listId: string; listName: string; tags: string[] };
}
export type Triage =
  | { action: "propose_session"; repo: string; workflow: string; request: string; reason: string }
  | { action: "notify"; summary: string; reason: string }
  | { action: "ignore"; reason: string };
export interface CatalogWorkflow { id: string; name: string; stages: string[] }
export interface Catalog { repos: string[]; workflows: CatalogWorkflow[] }
export interface SessionStatus {
  name: string; workflow: string | null; stage: string | null;
  stagesDone: number; stagesTotal: number;
  attention: "decision" | "working" | "idle" | "shell" | "gone" | null;
  needsInput: boolean; question?: string;
  options?: string[];
  gate: { stage: string; attempts?: number } | null;
}
export type ProposalStatus = "pending" | "approved" | "launched" | "failed" | "rejected" | "expired";
export interface Proposal {
  id: string; eventId: string; repo: string; workflowId: string; workflowName: string;
  request: string; origin: string; status: ProposalStatus;
  telegramMessageId: number | null; createdAt: number; updatedAt: number;
  sessionName: string | null; error: string | null;
}
