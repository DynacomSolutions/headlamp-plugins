import { ConfigStore, K8s } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { buildSites, mappingFrom, Site, Suffixes, suffixesFrom } from './model';

export const CONFIG_KEY = 'sites';
export const MAPPING_CRD = 'mappings.getambassador.io';

export interface PluginConfig {
  tailnetSuffixes?: string;
  lanSuffixes?: string;
  localSuffixes?: string;
}

export const configStore = new ConfigStore<PluginConfig>(CONFIG_KEY);

let defaultsPromise: Promise<PluginConfig> | null = null;

/**
 * Deployment-supplied defaults: an optional defaults.json shipped next to
 * main.js in the plugin directory (Headlamp serves it as a static file). Lets
 * an installer preconfigure the hostname suffixes without touching each browser.
 */
function loadDefaults(): Promise<PluginConfig> {
  if (!defaultsPromise) {
    defaultsPromise = fetch(`/plugins/${CONFIG_KEY}/defaults.json`)
      .then(r => (r.ok ? r.json() : {}))
      .then(j => (j && typeof j === 'object' ? (j as PluginConfig) : {}))
      .catch(() => ({}));
  }
  return defaultsPromise;
}

/** Stored settings layered over the deployment defaults (non-empty values win). */
export function useConfig(): PluginConfig {
  const stored = (configStore.useConfig()() || {}) as PluginConfig;
  const [defaults, setDefaults] = React.useState<PluginConfig>({});
  React.useEffect(() => {
    let alive = true;
    loadDefaults().then(d => alive && setDefaults(d));
    return () => {
      alive = false;
    };
  }, []);
  return React.useMemo(() => {
    const out: PluginConfig = { ...defaults };
    for (const [k, v] of Object.entries(stored)) if (v) (out as Record<string, string>)[k] = v as string;
    return out;
  }, [defaults, stored]);
}

export const Mapping = K8s.crd.makeCustomResourceClass({
  apiInfo: [{ group: 'getambassador.io', version: 'v3alpha1' }],
  kind: 'Mapping',
  pluralName: 'mappings',
  singularName: 'mapping',
  isNamespaced: true,
});

export interface SitesState {
  sites: Site[];
  suffixes: Suffixes;
  loading: boolean;
  /** the API says Mapping does not exist (Emissary not installed) */
  absent: boolean;
  /** any other error (for example RBAC) */
  error: string | null;
}

/** Live list/watch of every Mapping, folded into sites. */
export function useSites(): SitesState {
  const cfg = useConfig();
  const [items, err] = (Mapping as any).useList();
  const status = (err as any)?.status;
  const suffixes = React.useMemo(() => suffixesFrom(cfg), [cfg]);
  const sites = React.useMemo(
    () => buildSites((items || []).map((i: any) => mappingFrom(i.jsonData)), suffixes),
    [items, suffixes]
  );
  return {
    sites,
    suffixes,
    loading: items === null && !err,
    absent: status === 404,
    error: err && status !== 404 ? String((err as any).message || err) : null,
  };
}
