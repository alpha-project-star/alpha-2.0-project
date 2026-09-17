// public/sw.js
/**
 * Alpha - Minimal Service Worker for Browser Notification Support.
 *
 * Scoped strictly to standard notification click and window focusing.
 * Does not contain background schedulers, LLM execution, or credentials.
 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  try {
    const data = event.data ? event.data.json() : {};
    const title = data.title || '🔔 Alpha Reminder';
    const options = {
      body: data.body || '',
      tag: data.eventId || 'alpha-notification',
      icon: data.icon || '/icon-192.png',
      data: {
        eventId: data.eventId,
        reminderId: data.reminderId,
        url: data.url || '/',
        notes: data.notes,
        metadata: data.metadata,
      },
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    const title = '🔔 Alpha Reminder';
    const text = event.data ? event.data.text() : 'You have a new reminder due.';
    event.waitUntil(
      self.registration.showNotification(title, {
        body: text,
        icon: '/icon-192.png',
      })
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen);
      }
    })
  );
});
