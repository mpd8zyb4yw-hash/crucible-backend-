// Crucible service worker — PWA push notifications.
// The task runs server-side, so the server can notify "answer ready" even when the app is
// fully closed. We suppress the notification when a Crucible window is already focused.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch {}
  const title = data.title || 'Crucible'
  const body = data.body || 'Your answer is ready.'
  const url = data.url || '/'
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // If the user is actively looking at the app, don't interrupt them.
    if (windows.some((c) => c.focused)) return
    await self.registration.showNotification(title, {
      body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: 'crucible-answer',
      data: { url },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find((c) => 'focus' in c)
    if (existing) return existing.focus()
    return self.clients.openWindow(url)
  })())
})
