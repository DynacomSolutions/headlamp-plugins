/** Tabs of the Hardware profile section. The selected tab lives in the URL query as `hw`. */
export const HW_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'board', label: 'Board & CPU' },
  { id: 'memory', label: 'Memory' },
  { id: 'slots', label: 'Expansion slots' },
  { id: 'gpus', label: 'GPUs' },
  { id: 'storage', label: 'Storage' },
] as const;

export type HwTabId = (typeof HW_TABS)[number]['id'];

export const HW_PARAM = 'hw';
const DEFAULT_TAB: HwTabId = 'overview';

/** Reads the tab from a query string. A missing or unknown value gives the Overview tab. */
export function parseHwTab(search: string): HwTabId {
  const value = new URLSearchParams(search).get(HW_PARAM);
  return HW_TABS.find(t => t.id === value)?.id ?? DEFAULT_TAB;
}

/** Returns the query string with the tab set. Other parameters stay. Overview removes the parameter. */
export function withHwTab(search: string, tab: HwTabId): string {
  const params = new URLSearchParams(search);
  if (tab === DEFAULT_TAB) {
    params.delete(HW_PARAM);
  } else {
    params.set(HW_PARAM, tab);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
