import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { cleanErrorText } from './chat-model';
import { backendUrl, Settings } from './model';
import { currentSupport, existingSubscription, subscribeDevice, unsubscribeDevice } from './push';
import {
  deviceLabel,
  ID_MARK,
  parseConfig,
  parseView,
  presenceChat,
  PushConfig,
  PushSettings,
  PushSupport,
  PushView,
  subscriptionId,
  subscriptionParts,
  template,
} from './push-model';
import { chatUrl, diagnosisUrl } from './routes';

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const sub = (s: Settings, id: string, tail = '') =>
  backendUrl(s, `/api/push/subscriptions/${encodeURIComponent(id)}${tail}`);

export async function fetchPushConfig(s: Settings): Promise<PushConfig> {
  return parseConfig(await ApiProxy.request(backendUrl(s, '/api/push/config')));
}

/** This device's record on the agent, or null when the agent has none (HTTP 404). */
export async function fetchView(s: Settings, id: string): Promise<PushView | null> {
  try {
    return parseView(await ApiProxy.request(sub(s, id)));
  } catch (e: any) {
    if (e?.status === 404 || /\b404\b|not found/i.test(String(e?.message))) return null;
    throw e;
  }
}

/** The paths a notification opens. They hold the cluster, so the agent cannot build them itself. */
export function notificationUrls() {
  return {
    incident: template(diagnosisUrl(ID_MARK)),
    chat: template(chatUrl(ID_MARK)),
  };
}

export async function saveSubscription(
  s: Settings,
  id: string,
  device: PushSubscription,
  settings?: PushSettings
): Promise<PushView> {
  const view = parseView(
    await ApiProxy.request(
      sub(s, id),
      json('POST', {
        subscription: subscriptionParts(device),
        label: deviceLabel(navigator.userAgent),
        urls: notificationUrls(),
        ...(settings ? { settings } : {}),
      })
    )
  );
  if (!view) throw new Error('The agent did not return the subscription.');
  return view;
}

export async function saveSettings(
  s: Settings,
  id: string,
  settings: PushSettings
): Promise<PushView> {
  const view = parseView(
    await ApiProxy.request(
      sub(s, id, '/settings'),
      json('POST', { settings, urls: notificationUrls() })
    )
  );
  if (!view) throw new Error('The agent did not return the subscription.');
  return view;
}

export async function removeSubscription(s: Settings, id: string): Promise<void> {
  await ApiProxy.request(sub(s, id, '/unsubscribe'), json('POST', {}));
}

export async function reportPresence(
  s: Settings,
  id: string,
  chatId: string | null
): Promise<void> {
  await ApiProxy.request(sub(s, id, '/presence'), json('POST', { chatId }));
}

export interface PushDevice {
  support: PushSupport;
  config: PushConfig | null;
  /** This device's subscription id, when the browser has a subscription. */
  id: string | null;
  /** The agent's record of this device. */
  view: PushView | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  update: (settings: PushSettings) => Promise<void>;
}

/** The state of this device and the actions on it. The browser and the agent are outside React, so this syncs with them. */
export function usePushDevice(s: Settings): PushDevice {
  const support = React.useMemo(() => currentSupport(), []);
  const [config, setConfig] = React.useState<PushConfig | null>(null);
  const [id, setId] = React.useState<string | null>(null);
  const [view, setView] = React.useState<PushView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Keyed on the agent address, not on the settings object, which may be a new object on each render.
  const sRef = React.useRef(s);
  sRef.current = s;
  const agent = backendUrl(s, '/');
  const load = React.useCallback(async () => {
    const s = sRef.current;
    try {
      const cfg = await fetchPushConfig(s);
      setConfig(cfg);
      const device = await existingSubscription();
      const deviceId = device ? await subscriptionId(device.endpoint) : null;
      setId(deviceId);
      setView(deviceId && cfg.enabled ? await fetchView(s, deviceId) : null);
      setError(null);
    } catch (e) {
      setError(cleanErrorText(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);
  React.useEffect(() => {
    void load();
  }, [load]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(cleanErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return {
    support,
    config,
    id,
    view,
    loading,
    busy,
    error,
    enable: () =>
      act(async () => {
        if (!config?.publicKey) throw new Error('The agent has no web push key.');
        const device = await subscribeDevice(config.publicKey);
        const deviceId = await subscriptionId(device.endpoint);
        setId(deviceId);
        setView(await saveSubscription(s, deviceId, device));
      }),
    disable: () =>
      act(async () => {
        if (id) await removeSubscription(s, id);
        await unsubscribeDevice();
        setId(null);
        setView(null);
      }),
    update: (settings: PushSettings) =>
      act(async () => {
        if (!id) return;
        setView(await saveSettings(s, id, settings));
      }),
  };
}

/** The id of this device's subscription, for a chat to name. Empty when this device has none. */
export function usePushId(): string | undefined {
  const [id, setId] = React.useState<string | undefined>(undefined);
  React.useEffect(() => {
    let alive = true;
    existingSubscription()
      .then(d => (d ? subscriptionId(d.endpoint) : undefined))
      .then(v => alive && setId(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return id;
}

const HEARTBEAT_MS = 30_000;

/**
 * While a chat is open, tells the agent whether this page shows it: visible or hidden. The agent sends
 * a chat answer as a push only when this device is not showing the chat. A visible page repeats the
 * report every 30 seconds, because the agent forgets it after 75 seconds.
 */
export function useChatPresence(s: Settings, chatId: string | undefined, pushId: string | undefined) {
  const sRef = React.useRef(s);
  sRef.current = s;
  const agent = backendUrl(s, '/');
  React.useEffect(() => {
    if (!chatId || !pushId) return undefined;
    const s = sRef.current;
    const send = () => {
      void reportPresence(s, pushId, presenceChat(document.visibilityState, chatId)).catch(
        () => undefined
      );
    };
    send();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') send();
    }, HEARTBEAT_MS);
    const hide = () => void reportPresence(s, pushId, null).catch(() => undefined);
    document.addEventListener('visibilitychange', send);
    window.addEventListener('pagehide', hide);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', send);
      window.removeEventListener('pagehide', hide);
      hide();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, chatId, pushId]);
}
