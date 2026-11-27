import type { AutomaticInvestigationsState as StoredState } from '../settings.js';

/**
 * The "Automatic investigations" setting, as the MCP server shows it (contract section 5.5).
 * The setting module (`src/settings.ts`) owns the store and the change. This file only maps its fields.
 */
export interface AutomaticInvestigationsState {
  enabled: boolean;
  changedAt: string | null;
  changedBy: string | null;
}

export interface AutomaticInvestigationsView {
  get(): Promise<AutomaticInvestigationsState>;
}

/**
 * `updatedAt` becomes `changedAt`. `updatedBy` becomes `changedBy`: an empty name is `null`.
 * The name is a claim of the caller and not proof of identity (contract section 5.5).
 */
export function fromSetting(s: StoredState): AutomaticInvestigationsState {
  return { enabled: s.enabled, changedAt: s.updatedAt ?? null, changedBy: s.updatedBy ? s.updatedBy : null };
}
