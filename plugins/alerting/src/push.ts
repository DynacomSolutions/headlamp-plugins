/** Browser side of web push: service worker registration and this device's subscription. */
import { PushSupport, pushSupport, urlBase64ToBytes } from './model';

export const WORKER_URL = '/plugins/alerting/sw.js';
export const WORKER_SCOPE = '/plugins/alerting/';

export function currentSupport(): PushSupport {
  const standalone =
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as any).standalone === true;
  return pushSupport({
    ua: navigator.userAgent,
    standalone,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
  });
}

/**
 * Resolves once the registration has an active worker. navigator.serviceWorker.ready
 * is not usable here: it only resolves for a registration that controls the current
 * page, and the dashboard lives outside the plugin directory scope.
 */
function whenActive(reg: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> {
  if (reg.active) return Promise.resolve(reg);
  const worker = reg.installing || reg.waiting;
  if (!worker) return Promise.reject(new Error('The notification service worker did not start.'));
  return new Promise((resolve, reject) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve(reg);
      else if (worker.state === 'redundant')
        reject(new Error('The notification service worker failed to install.'));
    });
  });
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(WORKER_URL, { scope: WORKER_SCOPE });
  return whenActive(reg);
}

/** This device's existing subscription, without prompting or registering anything. */
export async function existingSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration(WORKER_SCOPE);
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Asks for permission (must follow a user gesture) and subscribes with the VAPID key. */
export async function subscribeDevice(publicKey: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser site settings, then try again.'
        : 'Notification permission was not granted.'
    );
  }
  const reg = await registration();
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBytes(publicKey) as BufferSource,
  });
}

export async function unsubscribeDevice(): Promise<string | null> {
  const sub = await existingSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}
