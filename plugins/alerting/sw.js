/* Service worker for the alerting plugin: shows push notifications and focuses
 * or opens the dashboard when one is clicked. Served next to main.js, so its
 * default scope is the plugin directory, which is all push delivery needs. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function parsePayload(event) {
  if (!event.data) return {};
  try {
    const json = event.data.json();
    return json && typeof json === 'object' ? json : {};
  } catch (e) {
    return { body: event.data.text() };
  }
}

self.addEventListener('push', event => {
  const data = parsePayload(event);
  const urgent = data.kind === 'urgent';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' && data.tag ? data.tag : 'alert',
    renotify: true,
    requireInteraction: urgent,
    data: { url: typeof data.url === 'string' && data.url ? data.url : '/' },
  };
  event.waitUntil(self.registration.showNotification(data.title || 'Alert', options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || '/',
    self.location.origin
  );
  // Never navigate off-origin from a notification payload.
  const href = target.origin === self.location.origin ? target.href : self.location.origin + '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
      const existing = windows.find(w => new URL(w.url).origin === self.location.origin);
      if (existing) {
        return existing.focus().then(() => {
          if (existing.navigate) return existing.navigate(href).catch(() => undefined);
          return undefined;
        });
      }
      return self.clients.openWindow(href);
    })
  );
});
