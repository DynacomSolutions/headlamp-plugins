import { ApiProxy, ConfigStore, K8s } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { backendUrl, Catalogue, CONFIG_KEY, parseCatalogue, resolveSettings, Settings } from './model';

export const configStore = new ConfigStore<Partial<Settings>>(CONFIG_KEY);

let defaultsPromise: Promise<Partial<Settings>> | null = null;

/** Deployment-supplied defaults: an optional defaults.json served next to main.js. */
function loadDefaults(): Promise<Partial<Settings>> {
  if (!defaultsPromise) {
    defaultsPromise = fetch(`/plugins/${CONFIG_KEY}/defaults.json`)
      .then(r => (r.ok ? r.json() : {}))
      .then(j => (j && typeof j === 'object' ? (j as Partial<Settings>) : {}))
      .catch(() => ({}));
  }
  return defaultsPromise;
}

/** Browser-local overrides layered over the deployment defaults and built-ins. */
export function useSettings(): Settings {
  const stored = configStore.useConfig()() as Partial<Settings> | undefined;
  const [defaults, setDefaults] = React.useState<Partial<Settings>>({});
  React.useEffect(() => {
    let alive = true;
    loadDefaults().then(d => alive && setDefaults(d));
    return () => {
      alive = false;
    };
  }, []);
  return React.useMemo(() => resolveSettings(stored, defaults), [stored, defaults]);
}

export interface CatalogueResult {
  catalogue: Catalogue | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Polls the catalogue backend through the Kubernetes API service proxy. */
export function useCatalogue(s: Settings): CatalogueResult {
  const [res, setRes] = React.useState<Omit<CatalogueResult, 'refresh'>>({
    catalogue: null,
    loading: true,
    error: null,
  });
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    const url = backendUrl(s, '/api/repositories');
    const load = async () => {
      try {
        const json = await ApiProxy.request(url);
        if (alive) setRes({ catalogue: parseCatalogue(json), loading: false, error: null });
      } catch (e: any) {
        if (alive) setRes(r => ({ ...r, loading: false, error: String(e?.message || e) }));
      }
    };
    load();
    const t = setInterval(load, s.refreshSeconds * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [s.namespace, s.service, s.port, s.refreshSeconds, tick]);
  const refresh = React.useCallback(() => setTick(n => n + 1), []);
  return { ...res, refresh };
}

/** Result of a Kubernetes list: items (JSON), loading, "CRD absent" and any other error. */
export interface ListResult {
  items: any[];
  loading: boolean;
  absent: boolean;
  error: string | null;
}

export function toResult(res: [any[] | null, any]): ListResult {
  const [items, err] = res;
  const status = err?.status;
  return {
    items: (items || []).map((i: any) => i.jsonData ?? i),
    loading: items === null && !err,
    absent: status === 404,
    error: err && status !== 404 ? String(err.message || err) : null,
  };
}

const crd = (group: string, version: string, kind: string, plural: string) =>
  K8s.crd.makeCustomResourceClass({
    apiInfo: [{ group, version }],
    kind,
    pluralName: plural,
    singularName: kind.toLowerCase(),
    isNamespaced: true,
  });

export const DataSource = crd('cdi.kubevirt.io', 'v1beta1', 'DataSource', 'datasources');
export const DataImportCron = crd('cdi.kubevirt.io', 'v1beta1', 'DataImportCron', 'dataimportcrons');
export const DataVolume = crd('cdi.kubevirt.io', 'v1beta1', 'DataVolume', 'datavolumes');
export const VirtualMachine = crd('kubevirt.io', 'v1', 'VirtualMachine', 'virtualmachines');
export const VirtualMachineInstance = crd('kubevirt.io', 'v1', 'VirtualMachineInstance', 'virtualmachineinstances');

/** Live list/watch; each wrapper is a hook, so call them unconditionally. */
export const useDataSources = () => toResult((DataSource as any).useList());
export const useDataImportCrons = () => toResult((DataImportCron as any).useList());
export const useDataVolumes = () => toResult((DataVolume as any).useList());
export const useVirtualMachines = () => toResult((VirtualMachine as any).useList());
export const useVirtualMachineInstances = () => toResult((VirtualMachineInstance as any).useList());
export const usePvcs = () => toResult((K8s.ResourceClasses.PersistentVolumeClaim as any).useList());
export const usePods = () => toResult((K8s.ResourceClasses.Pod as any).useList());
export const useNodes = () => toResult((K8s.ResourceClasses.Node as any).useList());
