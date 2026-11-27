import type { DiagnosisStore, SettingVia } from './store.js';

/** The store key of the switch. */
export const AUTOMATIC_INVESTIGATIONS_KEY = 'automatic-investigations';
/** On, as before the switch existed. */
export const AUTOMATIC_INVESTIGATIONS_DEFAULT = true;
/** The kind of the event that a change of the switch makes. The incident event source and MCP use this name. */
export const AUTOMATIC_INVESTIGATIONS_EVENT = 'settings.automatic_investigations.changed';

/** The switch as the API and MCP show it. `updatedAt` and `updatedBy` are absent until the first change. */
export interface AutomaticInvestigationsState {
  enabled: boolean;
  updatedAt?: string;
  /** The name that came with the change. Empty when the caller gave none. */
  updatedBy?: string;
  /** `proxy`: the change came through the Kubernetes service proxy (Headlamp). `direct`: it did not, so the name is only a claim. */
  updatedVia?: SettingVia;
}

/** One change, as the audit keeps it and as a listener gets it. */
export interface AutomaticInvestigationsChange {
  kind: typeof AUTOMATIC_INVESTIGATIONS_EVENT;
  at: string;
  by: string;
  via?: SettingVia;
  old: boolean;
  new: boolean;
}

export type SettingLog = (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;

/**
 * The state of the switch, read from the shared store. Every pod reads the store each time, so a change
 * on one pod shows on all of them at once. The MCP worker wires this function in as it is.
 */
export async function getAutomaticInvestigations(store: DiagnosisStore, log?: SettingLog): Promise<AutomaticInvestigationsState> {
  const stored = await store.getSetting(AUTOMATIC_INVESTIGATIONS_KEY);
  if (!stored) return { enabled: AUTOMATIC_INVESTIGATIONS_DEFAULT };
  if (typeof stored.value !== 'boolean') {
    // Someone wrote a value that is not true or false. The default holds, and the log says so.
    log?.('warn', 'setting has a value that is not a boolean, using the default', { setting: AUTOMATIC_INVESTIGATIONS_KEY, value: stored.value });
    return { enabled: AUTOMATIC_INVESTIGATIONS_DEFAULT };
  }
  return { enabled: stored.value, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy, ...(stored.updatedVia ? { updatedVia: stored.updatedVia } : {}) };
}

/** The switch "Automatic investigations": on by default, kept in the store, changed with an audit entry. */
export class AutomaticInvestigations {
  private warned = false;
  private readonly listeners = new Set<(change: AutomaticInvestigationsChange) => void>();

  constructor(
    private readonly store: DiagnosisStore,
    private readonly log: SettingLog = () => {},
  ) {}

  get(): Promise<AutomaticInvestigationsState> {
    // The warning shows once, so a bad stored value does not fill the log at each alert and each scrape.
    return getAutomaticInvestigations(this.store, (level, message, extra) => {
      if (this.warned) return;
      this.warned = true;
      this.log(level, message, extra);
    });
  }

  async enabled(): Promise<boolean> {
    return (await this.get()).enabled;
  }

  /**
   * Set the switch. The change and its audit entry go to the store in one step, then to the log and to the listeners.
   * `changed` is false when the value was the same: nothing is written then.
   * `by` is a name that the caller gave (empty when none). `via` tells if the change came through the service proxy.
   */
  async set(enabled: boolean, by: string, via?: SettingVia): Promise<{ state: AutomaticInvestigationsState; changed: boolean }> {
    const entry = await this.store.setSetting(AUTOMATIC_INVESTIGATIONS_KEY, enabled, by, AUTOMATIC_INVESTIGATIONS_DEFAULT, via);
    if (entry) {
      const change: AutomaticInvestigationsChange = { kind: AUTOMATIC_INVESTIGATIONS_EVENT, at: entry.at, by: entry.by, ...(entry.via ? { via: entry.via } : {}), old: entry.old === true, new: entry.new === true };
      this.log('info', 'setting changed', { setting: AUTOMATIC_INVESTIGATIONS_KEY, by: change.by, via: change.via, at: change.at, old: change.old, new: change.new });
      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch (error) {
          this.log('error', 'setting listener failed', { error: String(error) });
        }
      }
    }
    return { state: await this.get(), changed: entry !== undefined };
  }

  /** The changes, newest first. */
  async audit(limit = 50): Promise<AutomaticInvestigationsChange[]> {
    return (await this.store.settingAudit(AUTOMATIC_INVESTIGATIONS_KEY, limit)).map(e => ({ kind: AUTOMATIC_INVESTIGATIONS_EVENT, at: e.at, by: e.by, ...(e.via ? { via: e.via } : {}), old: e.old === true, new: e.new === true }));
  }

  /** Call `listener` after each change made on this pod. Returns a function that stops it. */
  onChange(listener: (change: AutomaticInvestigationsChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
