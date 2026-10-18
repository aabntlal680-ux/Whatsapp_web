importScripts(
  "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js"
);

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

const firebaseConfig = {
  apiKey: "AIzaSyDeg6RBNC9bWw1QYxBkYtCuMMFPBzxpw4o",
  authDomain: "studio-6422025604-b97aa.firebaseapp.com",
  projectId: "studio-6422025604-b97aa",
  storageBucket: "studio-6422025604-b97aa.firebasestorage.app",
  messagingSenderId: "599267399266",
  appId: "1:599267399266:web:329e49e24298af60f5e33b",
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// FCM may retry delivery. Keep a short-lived in-memory id cache so a retry
// cannot create two system notifications while this worker is alive.
const recentMessageIds = new Map();
const MESSAGE_DEDUP_WINDOW_MS = 60_000;

function wasRecentlyHandled(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  for (const [id, timestamp] of recentMessageIds) {
    if (now - timestamp > MESSAGE_DEDUP_WINDOW_MS) recentMessageIds.delete(id);
  }
  if (recentMessageIds.has(messageId)) return true;
  recentMessageIds.set(messageId, now);
  return false;
}

messaging.onBackgroundMessage((payload) => {
  console.log("[firebase-messaging-sw.js] Background message:", payload);

  // The sender uses data-only FCM messages. The notification fallback is kept
  // only for older queued messages during rollout.
  const data = payload?.data || {};
  const notification = payload?.notification || {};
  const messageId = data.messageId || data.message_id || payload?.messageId || "";
  if (wasRecentlyHandled(messageId)) return;

  const conversationId = data.conversationId || data.conversation_id || "";
  const title = data.title || notification.title || "رسالة جديدة";
  const body = data.body || notification.body || "لديك رسالة جديدة";

  const notificationOptions = {
    body,
    icon: data.icon || "./icons/icon.png",
    badge: data.badge || "./icons/icon.png",
    tag: messageId || conversationId || "whatsapp-message",
    renotify: true,
    requireInteraction: true,
    silent: false,
    data: { ...data, conversationId },
    vibrate: [100, 50, 100],
  };

  return self.registration.showNotification(title, notificationOptions);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification?.data || {};
  const conversationId = data.conversationId || data.conversation_id || "";
  const targetUrl = conversationId
    ? `./index.html?conversation=${encodeURIComponent(conversationId)}`
    : "./index.html";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            if (conversationId) {
              client.postMessage({
                type: "OPEN_CONVERSATION",
                conversationId,
              });
            }
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
        return null;
      })
  );
});

self.addEventListener("notificationclose", () => {
  // no-op
});
