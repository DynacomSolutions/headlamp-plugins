import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { Loaded, useLoaded } from './chat-data';
import {
  isLiveLaunch,
  LaunchConfig,
  LaunchDetail,
  LaunchFix,
  LaunchSummary,
  parseLaunch,
  parseLaunchConfig,
  parseLaunches,
} from './launch-model';
import { backendUrl, Settings } from './model';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export interface LaunchRequestBody {
  purpose: string;
  diagnosisId?: string;
  chatId?: string;
  fix?: LaunchFix;
  projectKey?: string;
}

const id = (value: string) => encodeURIComponent(value);

/* ---------- Calls ---------- */

export async function requestLaunch(s: Settings, body: LaunchRequestBody): Promise<LaunchDetail> {
  return parseLaunch(await ApiProxy.request(backendUrl(s, '/api/launches'), json('POST', body)));
}

export async function previewBrief(s: Settings, body: LaunchRequestBody): Promise<string> {
  const res = await ApiProxy.request(backendUrl(s, '/api/launches/preview'), json('POST', body));
  return res && typeof res.brief === 'string' ? res.brief : '';
}

export async function approveLaunch(s: Settings, launchId: string): Promise<LaunchDetail> {
  return parseLaunch(
    await ApiProxy.request(backendUrl(s, `/api/launches/${id(launchId)}/approve`), json('POST', {}))
  );
}

export async function rejectLaunch(s: Settings, launchId: string): Promise<LaunchDetail> {
  return parseLaunch(
    await ApiProxy.request(backendUrl(s, `/api/launches/${id(launchId)}/reject`), json('POST', {}))
  );
}

export async function sendLaunchMessage(
  s: Settings,
  launchId: string,
  text: string
): Promise<void> {
  await ApiProxy.request(
    backendUrl(s, `/api/launches/${id(launchId)}/messages`),
    json('POST', { text })
  );
}

/* ---------- Hooks ---------- */

/** Whether launching is on, the project keys and the thread link pattern. Read once. */
export function useLaunchConfig(s: Settings): Loaded<LaunchConfig> {
  return useLoaded(backendUrl(s, '/api/launches/config'), parseLaunchConfig, () => 0);
}

export function useLaunches(s: Settings): Loaded<LaunchSummary[]> {
  return useLoaded(backendUrl(s, '/api/launches?limit=100'), parseLaunches, () => 5000);
}

/** One launch. Polls every 1.5 s while the launch is live. A change of state by the operator calls `refresh`. */
export function useLaunch(s: Settings, launchId: string): Loaded<LaunchDetail> {
  return useLoaded(backendUrl(s, `/api/launches/${id(launchId)}`), parseLaunch, d =>
    d && !isLiveLaunch(d.status) ? 0 : 1500
  );
}
