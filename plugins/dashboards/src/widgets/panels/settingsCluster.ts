import { K8s } from '@kinvolk/headlamp-plugin/lib';

/**
 * The cluster a request must name when the page URL does not have one (the plugin settings page).
 * Headlamp gives one of the selected clusters, else the first configured cluster is used. On a
 * cluster route this is the cluster of the URL, so a plain request would give the same answer.
 */
export function useSettingsCluster(): string | undefined {
  const selected = K8s.useCluster();
  const clusters = K8s.useClustersConf();
  return selected ?? Object.keys(clusters ?? {})[0];
}
