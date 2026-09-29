import { describe, expect, it } from "vitest";
import { expandedRows } from "./expanded";
import { EMPTY_STATE } from "./model";
import type { PetState } from "./types";

describe("expandedRows", () => {
  it("returns no rows for an empty state", () => {
    expect(expandedRows(EMPTY_STATE)).toEqual([]);
  });

  it("returns one clickup row per pending proposal, carrying its url, proposalId and status", () => {
    const state: PetState = {
      ...EMPTY_STATE,
      pending: [
        { id: "p1", title: "Arreglar CSS", url: "https://app.clickup.com/t/p1", repo: "kitsune", workflow: "fix", createdAt: 0, status: "pending" },
      ],
    };
    expect(expandedRows(state)).toEqual([
      { label: "Arreglar CSS (fix)", kind: "clickup", url: "https://app.clickup.com/t/p1", proposalId: "p1", status: "pending" },
    ]);
  });

  it("carries status: \"failed\" for failed proposals", () => {
    const state: PetState = {
      ...EMPTY_STATE,
      pending: [
        { id: "p2", title: "Deploy roto", url: "https://app.clickup.com/t/p2", repo: "kitsune", workflow: "deploy", createdAt: 0, status: "failed" },
      ],
    };
    expect(expandedRows(state)).toEqual([
      { label: "Deploy roto (deploy)", kind: "clickup", url: "https://app.clickup.com/t/p2", proposalId: "p2", status: "failed" },
    ]);
  });

  it("returns one ronin row per session, without a url, reflecting stage/progress/question", () => {
    const state: PetState = {
      ...EMPTY_STATE,
      sessions: [
        { name: "sess-1", stage: "coding", stagesDone: 2, stagesTotal: 4, needsInput: false },
        { name: "sess-2", stage: null, stagesDone: 0, stagesTotal: 3, needsInput: true, question: "¿continuar?" },
      ],
    };
    expect(expandedRows(state)).toEqual([
      { label: "sess-1 · coding 2/4", kind: "ronin" },
      { label: "sess-2 · — 0/3 · pregunta", kind: "ronin" },
    ]);
  });

  it("lists pending rows before session rows", () => {
    const state: PetState = {
      ...EMPTY_STATE,
      pending: [{ id: "p1", title: "A", url: "https://x", repo: "r", workflow: "w", createdAt: 0, status: "pending" }],
      sessions: [{ name: "s1", stage: "x", stagesDone: 1, stagesTotal: 1, needsInput: false }],
    };
    expect(expandedRows(state).map((r) => r.kind)).toEqual(["clickup", "ronin"]);
  });
});
