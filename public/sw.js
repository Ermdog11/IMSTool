// Service worker. Two jobs:
//  1. Makes CoPublisher installable as a phone app (Android's install prompt
//     needs a service worker with a fetch handler; iPhone needs the app
//     installed to the home screen before it allows push notifications).
//     The fetch handler passes everything straight to the network: no offline
//     caching yet (Phase 3 in TODO.md).
//  2. Shows push notifications sent from api/_push.js (breaking news, roster
//     changes) and opens the right page when one is tapped.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* network as usual */ });

self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  var title = data.title || 'InsideMDSports Alert';
  var options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-32.png',
    data: { url: data.url || '/' },
    tag: data.tag || undefined
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        // Bring the open app forward on the alert's page (e.g. straight to the draft).
        if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) {
          return (list[i].navigate && list[i].url !== url ? list[i].navigate(url) : Promise.resolve()).then(function () { return list[i].focus(); }).catch(function () { return list[i].focus(); });
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
