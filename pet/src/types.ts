// Copied from daemon's src/events.ts and src/state.ts
export type TriageOutcome = "propose_session" | "notify" | "ignore" | "failed";
export type KitsuneEvent =
  | { type: "triage_started"; at: number; title: string }
  | { type: "event_triaged"; at: number; title: string; action: TriageOutcome }
  | { type: "proposal_created"; at: number; id: string; title: string; url: string; repo: string; workflow: string }
  | { type: "proposal_resolved"; at: number; id: string; status: "launched" | "failed" | "rejected" | "expired"; sessionName?: string }
  | { type: "session_update"; at: number; name: string; stage: string | null; stagesDone: number; stagesTotal: number }
  | { type: "session_question"; at: number; name: string; question: string }
  | { type: "session_done"; at: number; name: string }
  | { type: "session_dead"; at: number; name: string; reason: string }
  | { type: "error"; at: number; message: string };

export interface PendingItem {
  id: string;
  title: string;
  url: string;
  repo: string;
  workflow: string;
  createdAt: number;
  status: "pending" | "failed";
}

export interface SessionItem {
  name: string;
  stage: string | null;
  stagesDone: number;
  stagesTotal: number;
  needsInput: boolean;
  question?: string;
}

export interface PetState {
  triaging: boolean;
  pending: PendingItem[];
  sessions: SessionItem[];
  lastError: { message: string; at: number } | null;
}

export type PetAnimation = "sleeping" | "idle" | "sniffing" | "alert" | "working" | "asking" | "celebrate" | "sad";
export type PetStatus = "offline" | Exclude<PetAnimation, "celebrate">;
