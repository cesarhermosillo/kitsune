import type { ProposalStatus } from "./types.js";

const ALLOWED: Record<ProposalStatus, ProposalStatus[]> = {
  pending: ["approved", "rejected", "expired"],
  approved: ["launched", "failed"],
  failed: ["approved"],
  launched: [],
  rejected: [],
  expired: [],
};

export class InvalidTransition extends Error {
  constructor(readonly from: ProposalStatus, readonly to: ProposalStatus) {
    super(`transición inválida: ${from} → ${to}`);
  }
}

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return ALLOWED[from].includes(to);
}
