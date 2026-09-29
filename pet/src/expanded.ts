import type { PetState } from "./types";

export interface ExpandedRow {
  label: string;
  kind: "clickup" | "ronin";
  url?: string;
  proposalId?: string;
  status?: "pending" | "failed";
}

// Pure helper (spec §4): the rows shown in the expanded bubble on click —
// one per pending proposal (linking to ClickUp) and one per running session
// (linking to Ronin). Kept side-effect free so it's testable without a DOM.
export function expandedRows(state: PetState): ExpandedRow[] {
  const rows: ExpandedRow[] = [];
  for (const p of state.pending) {
    rows.push({
      label: `${p.title} (${p.workflow})`,
      kind: "clickup",
      url: p.url,
      proposalId: p.id,
      status: p.status,
    });
  }
  for (const s of state.sessions) {
    rows.push({
      label: `${s.name} · ${s.stage ?? "—"} ${s.stagesDone}/${s.stagesTotal}${s.needsInput ? " · pregunta" : ""}`,
      kind: "ronin",
    });
  }
  return rows;
}
