/* Status-bar badge for push notifications, shared by the service workers of the plugins.
 * Android shows the badge as the small icon of a notification. One open notification shows the
 * Headlamp logo. Two or more show a stack of squares. The service worker loads this file with
 * importScripts, and the PNGs sit next to it in the plugin directory. */
const BADGE_ONE = new URL('badge.png', self.location.href).href;
const BADGE_STACK = new URL('badge-stack.png', self.location.href).href;

function badgeFor(count) {
  return count > 1 ? BADGE_STACK : BADGE_ONE;
}

/* Shows the notification again with a new badge. It is silent and keeps its time, so the user
 * sees no new alert. */
function rebadge(notifications, badge) {
  return Promise.all(
    notifications
      .filter(n => n.badge !== badge)
      .map(n =>
        self.registration.showNotification(n.title, {
          body: n.body,
          tag: n.tag,
          data: n.data,
          requireInteraction: n.requireInteraction,
          timestamp: n.timestamp,
          badge,
          silent: true,
          renotify: false,
        })
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
      .showNotification(title, Object.assign({}, options, { badge }))
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
