/**
 * The "Automatic investigations" setting, as the MCP server reads it (contract section 5.5).
 * The store of the setting belongs to the settings worker. It plugs in here.
 */
export interface AutomaticInvestigationsState {
  enabled: boolean;
  changedAt: string | null;
  changedBy: string | null;
}

export interface AutomaticInvestigationsView {
  get(): Promise<AutomaticInvestigationsState>;
}

/** The default until the setting store exists: the agent investigates on its own, as before. */
export const alwaysOn: AutomaticInvestigationsView = { get: async () => ({ enabled: true, changedAt: null, changedBy: null }) };
