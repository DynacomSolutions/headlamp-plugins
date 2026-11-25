/* Service worker for the incident notifications: shows the push the agent sends and opens the
 * incident or the chat when it is tapped. Served next to main.js, so its default scope is the plugin
 * directory, which is all push delivery needs. */
importScripts('push-badge.js');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

/* The app may live under a base path. The scope is <base>/plugins/incidents/, so the base is what
 * comes before that. A path in a push is relative to the base. */
function basePath() {
  const path = new URL(self.registration.scope).pathname;
  const at = path.lastIndexOf('/plugins/incidents/');
  return at > 0 ? path.slice(0, at) : '';
}

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
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' && data.tag ? data.tag : 'incident',
    renotify: true,
    data: { url: typeof data.url === 'string' && data.url ? data.url : '/' },
  };
  event.waitUntil(
    showBadgedNotification(
      typeof data.title === 'string' && data.title ? data.title : 'Incident agent',
      options
    )
  );
});

self.addEventListener('notificationclose', event => {
  event.waitUntil(rebadgeAfterClose(event.notification.tag));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const closed = rebadgeAfterClose(event.notification.tag);
  const path = (event.notification.data && event.notification.data.url) || '/';
  // Only a path on this site: a payload never sends the user to another origin.
  const safe = typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
  const target = new URL(basePath() + (safe ? path : '/'), self.location.origin);
  const href = target.origin === self.location.origin ? target.href : self.location.origin + '/';
  const opened = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(windows => {
      const existing = windows.find(w => new URL(w.url).origin === self.location.origin);
      if (existing) {
        return existing.focus().then(() => {
          if (existing.navigate) return existing.navigate(href).catch(() => undefined);
          return undefined;
        });
      }
      return self.clients.openWindow(href);
    });
  event.waitUntil(Promise.all([closed, opened]));
});
