/* Status-bar badge for push notifications, shared by the service workers of the plugins.
 * Android shows the badge as the small icon of a notification. One open notification sets no
 * badge, so Android shows the normal Headlamp icon. Two or more show a stack of squares. The
 * service worker loads this file with importScripts, and the PNG sits next to it in the plugin
 * directory. */
const BADGE_STACK = new URL('badge-stack.png', self.location.href).href;

/* The badge for a count of open notifications. Undefined means no badge. */
function badgeFor(count) {
  return count > 1 ? BADGE_STACK : undefined;
}

/* A notification with no badge reports an empty string. */
function badgeOf(notification) {
  return notification.badge || undefined;
}

function withBadge(options, badge) {
  const next = Object.assign({}, options);
  delete next.badge;
  if (badge) next.badge = badge;
  return next;
}

/* Shows the notification again with a new badge. It is silent and keeps its time, so the user
 * sees no new alert. */
function rebadge(notifications, badge) {
  return Promise.all(
    notifications
      .filter(n => badgeOf(n) !== badge)
      .map(n =>
        self.registration.showNotification(
          n.title,
          withBadge(
            {
              body: n.body,
              tag: n.tag,
              data: n.data,
              requireInteraction: n.requireInteraction,
              timestamp: n.timestamp,
              silent: true,
              renotify: false,
            },
            badge
          )
        )
      )
  );
}

/* Shows a notification with the badge for the new count of open notifications. The other open
 * notifications get the same badge. */
function showBadgedNotification(title, options) {
  return self.registration.getNotifications().then(open => {
    const others = open.filter(n => n.tag !== options.tag);
    const badge = badgeFor(others.length + 1);
    return self.registration
      .showNotification(title, withBadge(options, badge))
      .then(() => rebadge(others, badge));
  });
}

/* Sets the badge of the open notifications after one closes. The closed one can still be in the
 * list for a short time, so its tag is excluded. */
function rebadgeAfterClose(closedTag) {
  return self.registration.getNotifications().then(open => {
    const left = open.filter(n => n.tag !== closedTag);
    return rebadge(left, badgeFor(left.length));
  });
}
