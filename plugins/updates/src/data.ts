import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import {
  parseReport,
  ParseResult,
  pickConfigMap,
  PREFERRED_NAMESPACE,
  REPORT_KEY,
  REPORT_LABEL,
} from './model';

export type LoadState =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'forbidden'; message: string }
  | { phase: 'error'; message: string }
  | { phase: 'loaded'; namespace: string; result: ParseResult };

const POLL_MS = 5 * 60 * 1000;
const selector = `labelSelector=${encodeURIComponent(REPORT_LABEL)}`;

const statusOf = (e: unknown): number | undefined => (e as { status?: number })?.status;

/** Read-only: lists ConfigMaps by label cluster-wide, falling back to the preferred namespace on 403. */
export async function loadReport(): Promise<LoadState> {
  try {
    let list;
    try {
      list = await ApiProxy.request(`/api/v1/configmaps?${selector}`);
    } catch (e) {
      if (statusOf(e) !== 403) throw e;
      list = await ApiProxy.request(
        `/api/v1/namespaces/${PREFERRED_NAMESPACE}/configmaps?${selector}`
      );
    }
    const cm = pickConfigMap(
      (list?.items ?? []) as {
        metadata?: { name?: string; namespace?: string };
        data?: Record<string, string>;
      }[]
    );
    if (!cm) return { phase: 'missing' };
    return {
      phase: 'loaded',
      namespace: cm.metadata?.namespace ?? '',
      result: parseReport(cm.data?.[REPORT_KEY]),
    };
  } catch (e) {
    const message = (e as Error)?.message || 'Request failed';
    return statusOf(e) === 403 ? { phase: 'forbidden', message } : { phase: 'error', message };
  }
}

export function useReport(): LoadState {
  const [state, setState] = React.useState<LoadState>({ phase: 'loading' });
  React.useEffect(() => {
    let alive = true;
    const run = () =>
      loadReport().then(s => {
        if (alive) setState(s);
      });
    run();
    const t = setInterval(run, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return state;
}
