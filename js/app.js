import { supabase } from "./supabaseClient.js";
import { signUp, signIn, signOut, getCurrentProfile } from "./auth.js";
import { ADMINS } from "./config.js";
import { applyLanguage } from "./i18n.js";
import {
  cacheMessages,
  deleteCachedMessage,
  getCachedMessages,
  cacheContacts,
  getCachedContacts,
  queueOutboxMessage,
  getOutbox,
  removeFromOutbox,
} from "./db.js";
import {
  enablePushNotifications,
  registerFcmToken,
  removeFcmToken,
  listenForForegroundMessages,
} from "./push.js";

const state = {
  me: null,
  t: null,
  lang: localStorage.getItem("wa_lang") || "ar",
  theme: localStorage.getItem("wa_theme") || "dark",

  contacts: [],
  contactRowsByConversation: {},

  // =============================================================
  // LIVE UI INDEX
  // conversationId -> HTMLElement
  // =============================================================
  contactElements: {},

  activeConversation: null,
  messages: [],
  reactions: {},
  replyingTo: null,

  msgChannel: null,
  typingChannel: null,
  reactionsChannel: null,
  presenceChannel: null,
  inboxChannel: null,
  globalMsgChannel: null,

  typingTimeout: null,
  onlineMap: {},
  heartbeatInterval: null,

  recording: null,

  isOnline: navigator.onLine,
  // هذا التطبيق نسخة PWA وليست React Native؛ document.visibilityState هو
  // المكافئ المباشر لـ AppState.active/background في المتصفح.
  appState: document.visibilityState === "visible" ? "active" : "background",

  clickedWelcomeButtons: new Set(),

  deferredInstallPrompt: null,
  installButton: null,

  mediaUploading: false,
  mediaUploadStatusElement: null,

  foregroundMessagesUnsub: null,
  realtimeReconnectTimer: null,
};

const $ = (sel) => document.querySelector(sel);

// ===============================================================
// BOOT
// ===============================================================

async function boot() {
  document.body.setAttribute("data-theme", state.theme);

  setupPWAInstallPrompt();

  await loadChatPanelPartial();

  state.t = applyLanguage(state.lang);

  const {
    data: { session },
  } = await supabase.auth.getSession();

  wireAuthForms();
  wireChrome();

  $("#boot-loading")?.classList.add("hidden");

  if (session) {
    await enterApp();
  } else {
    showAuthScreen();
  }

  // دورة FCM مرتبطة بمصدر الحقيقة الوحيد للمصادقة. نستخدم setTimeout حتى
  // لا ننفذ طلبات Supabase متداخلة داخل قفل onAuthStateChange الداخلي.
  supabase.auth.onAuthStateChange((event, session) => {
    setTimeout(async () => {
      if (
        (event === "SIGNED_IN" || event === "INITIAL_SESSION") &&
        session?.user
      ) {
        await registerFcmToken(session.user.id);
        return;
      }

      if (event === "SIGNED_OUT") {
        await removeFcmToken();
        state.me = null;
        showAuthScreen();
      }
    }, 0);
  });

  window.addEventListener("beforeunload", () => {
    if (state.me) {
      navigator.sendBeacon &&
        navigator.sendBeacon("about:blank");
    }
  });

  document.addEventListener("visibilitychange", async () => {
    state.appState = document.visibilityState === "visible" ? "active" : "background";

    if (!state.me) return;

    if (state.appState === "background") {
      await touchLastSeen(false);
    } else {
      await touchLastSeen(true);
      resubscribeRealtime();
    }
  });

  window.addEventListener("online", () => {
    state.isOnline = true;
    updateOfflineBanner();
    flushOutbox();
    resubscribeRealtime();
  });

  window.addEventListener("offline", () => {
    state.isOnline = false;
    updateOfflineBanner();
  });

  updateOfflineBanner();

  navigator.serviceWorker?.addEventListener("message", async (event) => {
    if (event.data?.type === "OPEN_CONVERSATION" && state.me) {
      await openConversationById(event.data.conversationId);
    }
  });

  window.addEventListener("popstate", (event) => {
    if (!event.state || !event.state.waChat) {
      closeChatView();
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#back-to-list")) {
      if (history.state && history.state.waChat) {
        history.back();
      } else {
        closeChatView();
      }
    }
  });

  refreshPWAInstallButton();
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted && supabase) {
    supabase.realtime.connect();
  }
});

window.addEventListener("pagehide", () => {
  if (supabase?.realtime) {
    supabase.realtime.disconnect();
  }
});

// ===============================================================
// CHAT VIEW
// ===============================================================

function openConversationUIState(conversationId) {
  document.body.classList.add("viewing-chat");

  const historyState = {
    waChat: true,
    conversationId,
  };

  if (history.state && history.state.waChat) {
    history.replaceState(
      historyState,
      "",
      "#chat"
    );
  } else {
    history.pushState(
      historyState,
      "",
      "#chat"
    );
  }
}

function closeChatView() {
  document.body.classList.remove("viewing-chat");
  closeMediaViewer();
  state.activeConversation = null;
  $("#chat-options-menu")?.classList.add("hidden");
  $("#chat-options-toggle")?.setAttribute("aria-expanded", "false");

  $("#chat-panel")?.classList.remove("mobile-visible");
  $("#sidebar")?.classList.remove("mobile-hidden");
}

// ===============================================================
// OFFLINE
// ===============================================================

function updateOfflineBanner() {
  const banner = $("#offline-banner");
  if (!banner) return;

  banner.classList.toggle("hidden", state.isOnline);
}

// ===============================================================
// CHAT PARTIAL
// ===============================================================

async function loadChatPanelPartial() {
  const res = await fetch("./partials/chat-panel.html");
  const html = await res.text();

  const container = $("#chat-panel-container");

  if (container) {
    container.innerHTML = html;
  }
}

// ===============================================================
// AUTH SCREEN
// ===============================================================

function showAuthScreen() {
  $("#auth-screen")?.classList.remove("hidden");
  $("#app-shell")?.classList.add("hidden");

  refreshPWAInstallButton();
}

// ===============================================================
// ENTER APP
// ===============================================================

async function enterApp() {
  state.me = await getCurrentProfile();

  if (!state.me) {
    showAuthScreen();
    return;
  }

  $("#auth-screen")?.classList.add("hidden");
  $("#app-shell")?.classList.remove("hidden");

  const moderationRoles = await getModerationRoles(state.me.id);
  state.me.chat_roles = moderationRoles;
  state.me.can_moderate = Boolean(
    state.me.is_admin ||
    moderationRoles.some((role) => ["admin", "moderator"].includes(role))
  );

  $("#my-name").textContent = state.me.display_name;

  if (state.me.avatar_url) {
    $("#my-avatar").src = state.me.avatar_url;
  }

  applyThemeVars();

  await touchLastSeen(true);
  startHeartbeat();

  await loadContacts();

  subscribeGlobalPresence();
  subscribeInboxUpdates();
  subscribeGlobalMessageWatch();

  if (!state.foregroundMessagesUnsub) {
    try {
      state.foregroundMessagesUnsub =
        listenForForegroundMessages({
          onNotification: handleForegroundNotification,
        });
    } catch (err) {
      console.error(
        "تعذّر تفعيل استماع رسائل FCM الأمامية:",
        err
      );
    }
  }

  if (state.isOnline) {
    flushOutbox();
  }

  await openConversationFromNotificationRoute();
}

// ===============================================================
// LIVE FOREGROUND NOTIFICATION
// ===============================================================

function extractNotificationMessage(payload) {
  if (!payload) return null;

  const candidates = [
    payload?.message,
    payload?.new,
    payload?.data,
    payload,
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    if (
      candidate.conversation_id ||
      candidate.conversationId
    ) {
      return {
        ...candidate,
        conversation_id:
          candidate.conversation_id ||
          candidate.conversationId,
      };
    }
  }

  return null;
}

function showInAppNotification({ title, body, conversationId }) {
  let banner = $("#in-app-notification");
  if (!banner) {
    banner = document.createElement("button");
    banner.id = "in-app-notification";
    banner.type = "button";
    banner.className = "in-app-notification hidden";
    document.body.appendChild(banner);
  }

  banner.innerHTML = `
    <strong>${escapeHtml(title || "رسالة جديدة")}</strong>
    <span>${escapeHtml(body || "لديك رسالة جديدة")}</span>
  `;
  banner.classList.remove("hidden");
  clearTimeout(banner._hideTimeout);
  banner._hideTimeout = setTimeout(() => banner.classList.add("hidden"), 6500);

  banner.onclick = async () => {
    banner.classList.add("hidden");
    if (conversationId) await openConversationById(conversationId);
  };
}

async function handleForegroundNotification(notification) {
  if (state.appState !== "active") return;

  const payload = notification?.payload || notification;
  const data = notification?.data || payload?.data || {};
  const conversationId = data.conversation_id || data.conversationId || payload?.conversation_id || payload?.conversationId;
  const message = extractNotificationMessage(payload);

  showInAppNotification({
    title: notification?.title || data.title || "رسالة جديدة",
    body: notification?.body || data.body || message?.content || "لديك رسالة جديدة",
    conversationId,
  });

  if (message?.conversation_id) {
    await patchContactUIOnNewMessage(message);
  } else {
    // إذا لم يرسل FCM بيانات الرسالة نفسها، نعيد مزامنة البيانات
    // بدون إعادة تحميل الصفحة.
    await loadContacts();
  }
}

// ===============================================================
// LAST SEEN
// ===============================================================

async function touchLastSeen(online) {
  if (!state.me) return;

  try {
    await supabase
      .from("profiles")
      .update({
        is_online: online,
        last_seen: new Date().toISOString(),
      })
      .eq("id", state.me.id);
  } catch (err) {
    console.error("touchLastSeen failed:", err);
  }
}

function startHeartbeat() {
  clearInterval(state.heartbeatInterval);

  state.heartbeatInterval = setInterval(() => {
    if (document.visibilityState === "visible") {
      touchLastSeen(true);
    }
  }, 25000);
}

// ===============================================================
// AUTH FORMS
// ===============================================================

function wireAuthForms() {
  $("#tab-login")?.addEventListener("click", () => {
    switchAuthTab("login");
  });

  $("#tab-signup")?.addEventListener("click", () => {
    switchAuthTab("signup");
  });

  $("#login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;

    try {
      await signIn({ email, password });
      await enterApp();
    } catch (err) {
      showAuthError(err.message);
    }
  });

  $("#signup-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = $("#signup-email").value.trim();
    const password = $("#signup-password").value;
    const displayName = $("#signup-name").value.trim();
    const phone = $("#signup-phone").value.trim();

    try {
      await signUp({
        email,
        password,
        displayName,
        phone,
      });

      await signIn({
        email,
        password,
      });

      await enterApp();
    } catch (err) {
      showAuthError(err.message);
    }
  });
}

function switchAuthTab(which) {
  $("#tab-login")?.classList.toggle(
    "active",
    which === "login"
  );

  $("#tab-signup")?.classList.toggle(
    "active",
    which === "signup"
  );

  $("#login-form")?.classList.toggle(
    "hidden",
    which !== "login"
  );

  $("#signup-form")?.classList.toggle(
    "hidden",
    which !== "signup"
  );
}

function showAuthError(msg) {
  const text =
    msg ||
    state.t?.error_generic ||
    "حدث خطأ ما";

  const authScreenVisible =
    !$("#auth-screen")?.classList.contains("hidden");

  if (authScreenVisible) {
    const el = $("#auth-error");

    if (el) {
      el.textContent = text;
      el.classList.remove("hidden");

      setTimeout(() => {
        el.classList.add("hidden");
      }, 4000);
    }

    return;
  }

  const toast = $("#global-toast");

  if (!toast) return;

  toast.textContent = text;
  toast.classList.remove("hidden");

  clearTimeout(toast._hideTimeout);

  toast._hideTimeout = setTimeout(() => {
    toast.classList.add("hidden");
  }, 5000);
}

// ===============================================================
// CHROME
// ===============================================================

function wireChrome() {
  $("#btn-settings")?.addEventListener("click", () => {
    $("#settings-panel")?.classList.toggle("hidden");
  });

  $("#btn-logout")?.addEventListener("click", async () => {
    await signOut(state.me?.id);
    location.reload();
  });

  $("#lang-toggle")?.addEventListener(
    "click",
    toggleLanguage
  );

  $("#theme-toggle")?.addEventListener(
    "click",
    toggleTheme
  );

  $("#auth-lang-toggle")?.addEventListener(
    "click",
    toggleLanguage
  );

  $("#auth-theme-toggle")?.addEventListener(
    "click",
    toggleTheme
  );

  $("#avatar-input")?.addEventListener(
    "change",
    handleAvatarUpload
  );

  $("#btn-remove-avatar")?.addEventListener("click", removeAvatar);
  $("#btn-remove-wallpaper")?.addEventListener("click", removeWallpaper);

  document.addEventListener("click", (event) => {
    const panel = $("#settings-panel");
    const trigger = $("#btn-settings");
    if (panel && !panel.classList.contains("hidden") &&
        !panel.contains(event.target) && event.target !== trigger) {
      panel.classList.add("hidden");
    }
  });

  $("#wallpaper-input")?.addEventListener(
    "change",
    handleWallpaperUpload
  );

  $("#btn-enable-push")?.addEventListener(
    "click",
    async () => {
      if (!state.me) return;

      const ok = await enablePushNotifications(
        state.me.id
      );

      showAuthError(
        ok
          ? "تم تفعيل الإشعارات ✅"
          : "تعذّر التفعيل — تحقق من إذن المتصفح أو مفتاح VAPID"
      );
    }
  );

  wireChatPanel();
  wireConversationOptions();
  wireMediaViewer();
  wireEmojiPicker();
}

// ===============================================================
// LANGUAGE
// ===============================================================

function toggleLanguage() {
  state.lang = state.lang === "ar" ? "en" : "ar";

  localStorage.setItem("wa_lang", state.lang);

  state.t = applyLanguage(state.lang);
}

// ===============================================================
// THEME
// ===============================================================

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";

  localStorage.setItem("wa_theme", state.theme);

  document.body.setAttribute(
    "data-theme",
    state.theme
  );

  applyThemeVars();
}

// ===============================================================
// CHAT PANEL
// ===============================================================

function wireChatPanel() {
  $("#composer-form")?.addEventListener(
    "submit",
    async (e) => {
      e.preventDefault();

      if (state.mediaUploading) return;

      const input = $("#composer-input");
      const text = input.value.trim();

      if (!text) return;

      input.value = "";

      await sendMessage({
        content: text,
      });
    }
  );

  $("#composer-input")?.addEventListener(
    "input",
    handleTypingInput
  );

  $("#attach-input")?.addEventListener(
    "change",
    handleAttachmentUpload
  );

  $("#reply-preview-cancel")?.addEventListener(
    "click",
    clearReply
  );

  $("#mic-btn")?.addEventListener(
    "click",
    toggleRecording
  );

  $("#recording-cancel")?.addEventListener(
    "click",
    cancelRecording
  );
}

function wireConversationOptions() {
  $("#chat-options-toggle")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("#chat-options-menu");
    if (!menu) return;
    const willOpen = menu.classList.contains("hidden");
    updateConversationOptions();
    menu.classList.toggle("hidden", !willOpen);
    $("#chat-options-toggle")?.setAttribute("aria-expanded", String(willOpen));
  });

  $("#chat-remove-member")?.addEventListener("click", async () => {
    $("#chat-options-menu")?.classList.add("hidden");
    await removeActiveChatMember();
  });

  document.addEventListener("click", (event) => {
    const menu = $("#chat-options-menu");
    const trigger = $("#chat-options-toggle");
    if (menu && !menu.contains(event.target) && event.target !== trigger) {
      menu.classList.add("hidden");
      trigger?.setAttribute("aria-expanded", "false");
    }
  });
}

function wireMediaViewer() {
  $("#media-viewer-close")?.addEventListener("click", closeMediaViewer);
  $("#media-viewer-modal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeMediaViewer();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMediaViewer();
  });
}

// ===============================================================
// THEME VARIABLES
// ===============================================================

function applyThemeVars() {
  if (state.me?.wallpaper_url) {
    const chatMessages = $("#chat-messages");

    if (chatMessages) {
      chatMessages.style.backgroundImage =
        `url("${state.me.wallpaper_url}")`;
    }
  }
}

// ===============================================================
// CONTACT INDEX
// ===============================================================

function resetContactIndex() {
  state.contactRowsByConversation = {};
  state.contactElements = {};
}

function indexContactElement(conversationId, element) {
  if (!conversationId || !element) return;

  state.contactElements[conversationId] = element;
  state.contactRowsByConversation[conversationId] = element;

  element.dataset.conversationId = conversationId;
}

// ===============================================================
// CONTACTS
// ===============================================================

async function loadContacts() {
  if (!state.me) return;

  if (!state.isOnline) {
    const cached = await getCachedContacts();
    renderContactsFromCache(cached);
    return;
  }

  try {
    if (!$("#contact-list")?.children.length &&
        !$("#users-section")?.children.length) {
      renderContactsFromCache(await getCachedContacts());
    }

    await loadContactsFromNetwork();
  } catch (err) {
    console.error("loadContacts failed:", err);

    const cached = await getCachedContacts();
    renderContactsFromCache(cached);
  }
}

function renderContactsFromCache(cached) {
  resetContactIndex();

  $("#contact-list").innerHTML = "";

  $("#admins-heading")?.classList.add("hidden");
  $("#admins-section")?.classList.add("hidden");

  $("#users-heading")?.classList.add("hidden");
  $("#users-section")?.classList.add("hidden");

  [...(cached || [])]
    .sort(compareContactsByActivity)
    .forEach((c) => {
      $("#contact-list").appendChild(
        buildContactRow(c, {
          withUnread: !!c._unread,
        })
      );
    });
}

function compareContactsByActivity(first, second) {
  const firstTime = Date.parse(
    first?._lastMessageAt || first?.last_message_at || ""
  ) || 0;
  const secondTime = Date.parse(
    second?._lastMessageAt || second?.last_message_at || ""
  ) || 0;

  return secondTime - firstTime;
}

async function getConversationUnreadCounts(conversationIds) {
  const counts = {};

  if (!state.me || !conversationIds.length) return counts;

  try {
    const { data, error } = await supabase
      .from("messages")
      .select("conversation_id")
      .in("conversation_id", conversationIds)
      .neq("sender_id", state.me.id)
      .or("status.is.null,status.neq.read");

    if (error) {
      console.warn("Unread count query failed:", error?.message || error);
      return counts;
    }

    for (const message of data || []) {
      counts[message.conversation_id] =
        (counts[message.conversation_id] || 0) + 1;
    }

    return counts;
  } catch (error) {
    console.warn("Unread count fetch failed:", error?.message || error);
    return counts;
  }
}

async function loadContactsFromNetwork() {
  resetContactIndex();

  if (!state.me.can_moderate) {
    const [profilesResult, conversationsResult] = await Promise.all([
      supabase
        .from("profiles")
        .select("*")
        .in(
          "email",
          ADMINS.map((a) => a.email)
        ),
      supabase
        .from("conversations")
        .select("*")
        .eq("user_id", state.me.id)
        .order("last_message_at", {
          ascending: false,
        }),
    ]);

    const adminProfiles = profilesResult.data;
    const userConversations = conversationsResult.data;

    const unreadCounts = await getConversationUnreadCounts(
      (userConversations || []).map((conversation) => conversation.id)
    );

    const rows = (adminProfiles || []).map((profile) => {
        const conversation =
          userConversations?.find(
            (c) => c.admin_id === profile.id
          ) || null;

        return {
          ...profile,
          _conversationId: conversation?.id || null,
          _unread: conversation
            ? unreadCounts[conversation.id] || 0
            : 0,
          _lastMessage: conversation?.last_message || null,
          _lastMessageAt: conversation?.last_message_at || null,
        };
      });

    state.contacts = rows.sort(compareContactsByActivity);

    $("#contact-list").innerHTML = "";

    $("#admins-heading")?.classList.add("hidden");
    $("#admins-section")?.classList.add("hidden");

    $("#users-heading")?.classList.add("hidden");
    $("#users-section")?.classList.add("hidden");

    state.contacts.forEach((c) => {
      $("#contact-list").appendChild(
        buildContactRow(c, {
          withUnread: true,
        })
      );
    });

    await cacheContacts(state.contacts);
    return;
  }

  $("#contact-list").innerHTML = "";

  $("#admins-heading")?.classList.remove("hidden");
  $("#admins-section")?.classList.remove("hidden");

  $("#users-heading")?.classList.remove("hidden");
  $("#users-section")?.classList.remove("hidden");

  const [otherAdminsResult, conversationsResult] = await Promise.all([
    supabase
      .from("profiles")
      .select("*")
      .eq("is_admin", true)
      .neq("id", state.me.id),
    supabase
      .from("conversations")
      .select(
        state.me.is_super_admin
          ? "*, user:profiles!conversations_user_id_fkey(*), owner_admin:profiles!conversations_admin_id_fkey(*)"
          : "*, user:profiles!conversations_user_id_fkey(*)"
      )
      .order("last_message_at", {
        ascending: false,
      }),
  ]);

  const otherAdmins = otherAdminsResult.data;

  const convs = state.me.is_super_admin
    ? conversationsResult.data
    : state.me.is_admin
    ? (conversationsResult.data || []).filter(
        (conversation) => conversation.admin_id === state.me.id
      )
    : (conversationsResult.data || []);
  const convsError = conversationsResult.error;

  if (convsError) {
    console.error(
      "تعذّر جلب المحادثات:",
      convsError
    );
  }

  const userContacts = [];
  const unreadCounts = await getConversationUnreadCounts(
    (convs || []).map((conversation) => conversation.id)
  );

  for (const c of convs || []) {
    userContacts.push({
      ...c.user,
      _conversationId: c.id,
      _adminId: c.admin_id,
      _unread: unreadCounts[c.id] || 0,
      _lastMessage: c.last_message,
      _lastMessageAt: c.last_message_at || null,
      _ownerAdminName:
        state.me.is_super_admin &&
        c.owner_admin?.id !== state.me.id
          ? c.owner_admin?.display_name
          : null,
    });
  }

  $("#admins-section").innerHTML = "";

  (otherAdmins || []).forEach((c) => {
    $("#admins-section").appendChild(
      buildContactRow(c, {
        withUnread: false,
      })
    );
  });

  $("#users-section").innerHTML = "";

  userContacts.sort(compareContactsByActivity).forEach((c) => {
    $("#users-section").appendChild(
      buildContactRow(c, {
        withUnread: true,
      })
    );
  });

  await cacheContacts([
    ...(otherAdmins || []),
    ...userContacts,
  ]);
}

// ===============================================================
// CONTACT ROW
// ===============================================================

function buildContactRow(c, opts = {}) {
  const row = document.createElement("div");

  row.className = "contact-row";

  const initials =
    (c.display_name || "?")
      .trim()
      .charAt(0);

  const online =
    c.id &&
    state.onlineMap[c.id];

  row.innerHTML = `
    <div class="avatar">
      ${
        c.avatar_url
          ? `<img src="${escapeHtml(c.avatar_url)}" alt="">`
          : initials
      }

      ${
        online
          ? '<span class="dot-online"></span>'
          : ""
      }
    </div>

    <div class="contact-info">
      <div class="contact-name">
        ${escapeHtml(c.display_name)}
        ${
          c._ownerAdminName
            ? `<span class="owner-admin-badge">${escapeHtml(
                c._ownerAdminName
              )}</span>`
            : ""
        }
      </div>

      <div class="contact-sub">
        ${escapeHtml(c._lastMessage || "")}
      </div>
    </div>

    ${
      opts.withUnread && c._unread
        ? `<div class="unread-badge">${c._unread}</div>`
        : ""
    }
  `;

  row.addEventListener("click", () => {
    openConversation(c);
  });

  if (state.me?.is_admin && !c.is_admin && c.id) {
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "contact-delete-btn";
    deleteButton.title = "حذف المستخدم";
    deleteButton.textContent = "🗑️";
    deleteButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteUser(c);
    });
    row.appendChild(deleteButton);
  }

  if (c._conversationId) {
    indexContactElement(
      c._conversationId,
      row
    );

    row.dataset.unread =
      String(c._unread || 0);
  }

  return row;
}

// ===============================================================
// LIVE CONTACT DOM PATCHING
// ===============================================================

/**
 * تحديث صف المحادثة مباشرة بدون إعادة بناء القائمة كاملة.
 *
 * يقوم بـ:
 * 1. تحديث آخر رسالة.
 * 2. زيادة/تصفير unread.
 * 3. تحريك المحادثة إلى أعلى قسمها.
 * 4. إبقاء مرجع العنصر في state.contactElements.
 */
async function patchContactUIOnNewMessage(
  message,
  options = {}
) {
  if (!message || !message.conversation_id) {
    return;
  }

  const conversationId =
    message.conversation_id;

  const isMine =
    message.sender_id === state.me?.id;

  const isActive =
    state.activeConversation?.id ===
    conversationId;

  const preview =
    messagePreviewText(message);

  let row =
    state.contactElements[
      conversationId
    ];

  // -------------------------------------------------------------
  // إذا كان الصف موجوداً، نعمل DOM patch مباشرة.
  // -------------------------------------------------------------

  if (row) {
    const sub =
      row.querySelector(".contact-sub");

    if (sub) {
      sub.textContent = preview;
    }

    row.dataset.lastMessageAt =
      message.created_at || new Date().toISOString();

    let unread =
      parseInt(
        row.dataset.unread || "0",
        10
      );

    if (
      !isMine &&
      !isActive &&
      options.incrementUnread !== false
    ) {
      unread += 1;
    }

    if (isActive || isMine) {
      unread = 0;
    }

    row.dataset.unread =
      String(unread);

    let badge =
      row.querySelector(".unread-badge");

    if (unread > 0) {
      if (!badge) {
        badge =
          document.createElement("div");

        badge.className =
          "unread-badge";

        row.appendChild(badge);
      }

      badge.textContent =
        String(unread);
    } else {
      badge?.remove();
    }

    moveContactRowToTop(row);

    return;
  }

  // -------------------------------------------------------------
  // إذا لم يكن الصف مفهرساً بعد، نحاول تحديث القائمة من الشبكة.
  // هذا fallback وليس المسار الطبيعي للـ Live UI.
  // -------------------------------------------------------------

  await loadContacts();
}

/**
 * نقل صف المحادثة إلى أعلى القسم الذي يحتويه.
 */
function moveContactRowToTop(row) {
  if (!row || !row.parentElement) return;

  const parent = row.parentElement;

  if (parent.firstElementChild !== row) {
    parent.prepend(row);
  }
}

/**
 * تحديث صف موجود عند وصول تحديث conversations.
 */
function patchContactUIOnConversationUpdate(
  conversation
) {
  if (!conversation?.id) return;

  const row =
    state.contactElements[
      conversation.id
    ];

  if (!row) {
    loadContacts();
    return;
  }

  const sub =
    row.querySelector(".contact-sub");

  if (sub && conversation.last_message !== undefined) {
    sub.textContent =
      conversation.last_message || "";
  }

  if (conversation.last_message_at) {
    row.dataset.lastMessageAt =
      conversation.last_message_at;
  }

  moveContactRowToTop(row);
}

// ===============================================================
// UNREAD BADGES
// ===============================================================

function bumpUnreadBadge(conversationId) {
  const row =
    state.contactElements[
      conversationId
    ];

  if (!row) {
    loadContacts();
    return;
  }

  const current =
    parseInt(
      row.dataset.unread || "0",
      10
    ) + 1;

  row.dataset.unread =
    String(current);

  let badge =
    row.querySelector(".unread-badge");

  if (!badge) {
    badge =
      document.createElement("div");

    badge.className =
      "unread-badge";

    row.appendChild(badge);
  }

  badge.textContent =
    String(current);

  moveContactRowToTop(row);
}

function clearUnreadBadge(conversationId) {
  const row =
    state.contactElements[
      conversationId
    ];

  if (!row) return;

  row.dataset.unread = "0";

  row.querySelector(
    ".unread-badge"
  )?.remove();
}

// ===============================================================
// HTML ESCAPE
// ===============================================================

function escapeHtml(str) {
  const d = document.createElement("div");

  d.textContent = str || "";

  return d.innerHTML;
}

async function openConversationFromNotificationRoute() {
  const conversationId = new URLSearchParams(location.search).get("conversation");
  if (conversationId) await openConversationById(conversationId);
}

async function openConversationById(conversationId) {
  if (!conversationId || !state.me) return;
  const { data: conversation, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !conversation) return;
  const otherId = state.me.can_moderate
    ? conversation.user_id
    : conversation.admin_id;
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", otherId).maybeSingle();
  if (profile) await openConversation({ ...profile, _conversationId: conversationId });
}

// ===============================================================
// CONVERSATION
// ===============================================================

function isActiveChatModerator() {
  return ["admin", "moderator"].includes(
    state.activeConversation?.memberRole
  );
}

function getActiveChatTargetId() {
  const conversation = state.activeConversation;
  if (!conversation || !state.me?.id) return null;
  return String(state.me.id) === String(conversation.userId)
    ? conversation.adminId
    : conversation.userId;
}

function updateConversationOptions() {
  const removeButton = $("#chat-remove-member");
  if (!removeButton) return;

  const canRemove = Boolean(
    isActiveChatModerator() &&
    getActiveChatTargetId() &&
    String(getActiveChatTargetId()) !== String(state.me?.id)
  );

  removeButton.classList.toggle("hidden", !canRemove);
}

async function getModerationRoles(userId) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from("chat_members")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "moderator"]);
  if (error) {
    console.warn("تعذّر قراءة أدوار المستخدم:", error.message);
    return [];
  }
  return [...new Set((data || []).map((item) => item.role))];
}

async function getChatMemberRole(conversationId, userId) {
  if (!conversationId || !userId) return null;
  const { data, error } = await supabase
    .from("chat_members")
    .select("role")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.warn("تعذّر قراءة دور عضو المحادثة:", error.message);
    return null;
  }

  return data?.role || null;
}

async function removeActiveChatMember() {
  const conversation = state.activeConversation;
  const targetUserId = getActiveChatTargetId();

  if (!conversation?.id || !isActiveChatModerator() || !targetUserId) return;
  if (!window.confirm("حذف المستخدم من هذه المحادثة؟")) return;

  const { error } = await supabase.rpc("remove_chat_member", {
    p_conversation_id: conversation.id,
    p_user_id: targetUserId,
  });

  if (error) {
    showAuthError("تعذّر حذف المستخدم من المحادثة: " + error.message);
    return;
  }

  closeChatView();
  await loadContacts();
  showAuthError("تم حذف المستخدم من المحادثة.");
}

async function openConversation(otherProfile) {
  if (!otherProfile.id) {
    showAuthError(
      "هذا المشرف لم يُنشئ حسابه في التطبيق بعد، لا يمكن بدء محادثة معه حالياً."
    );

    return;
  }

  try {
    $("#chat-empty-state")?.classList.add(
      "hidden"
    );

    $("#chat-active")?.classList.remove(
      "hidden"
    );

    clearReply();

    const isStaffOpeningUserChat = Boolean(
      state.me.can_moderate && otherProfile._conversationId
    );
    const userId = isStaffOpeningUserChat || state.me.is_admin
      ? otherProfile.id
      : state.me.id;
    const adminId = isStaffOpeningUserChat
      ? otherProfile._adminId || state.me.id
      : state.me.is_admin
      ? state.me.id
      : otherProfile.id;

    let conversationId =
      otherProfile._conversationId;

    if (!conversationId) {
      const {
        data: existing,
        error: selectErr,
      } = await supabase
        .from("conversations")
        .select("*")
        .eq("user_id", userId)
        .eq("admin_id", adminId)
        .maybeSingle();

      if (selectErr) {
        throw selectErr;
      }

      if (existing) {
        conversationId =
          existing.id;
      } else {
        const {
          data: created,
          error,
        } = await supabase
          .from("conversations")
          .insert({
            user_id: userId,
            admin_id: adminId,
          })
          .select()
          .single();

        if (error) {
          throw error;
        }

        conversationId =
          created.id;
      }
    }

    const memberRole = await getChatMemberRole(conversationId, state.me.id);

    state.activeConversation = {
      id: conversationId,
      userId,
      adminId,
      otherProfile,
      memberRole,
    };

    updateConversationOptions();

    openConversationUIState(
      conversationId
    );

    $("#chat-header-name").textContent =
      otherProfile.display_name;

    $("#chat-header-avatar").src =
      otherProfile.avatar_url || "";

    await refreshPresenceLabel(
      otherProfile.id
    );

    await loadMessages(
      conversationId
    );

    await loadReactionsForConversation();

    subscribeToConversation(
      conversationId
    );

    // ===========================================================
    // LIVE: تصفير العداد فور فتح المحادثة
    // ===========================================================
    clearUnreadBadge(
      conversationId
    );

    await markConversationRead(
      conversationId
    );
  } catch (err) {
    console.error(
      "openConversation failed:",
      err
    );

    showAuthError(
      "تعذّر فتح المحادثة: " +
        (err?.message ||
          "خطأ غير معروف") +
        " — تأكد من تشغيل sql/schema.sql بالكامل ومن صحة SUPABASE_URL/ANON_KEY في js/config.js"
    );

    closeChatView();
  }
}

// ===============================================================
// LOAD MESSAGES
// ===============================================================

async function loadMessages(conversationId) {
  const cached =
    await getCachedMessages(
      conversationId
    );

  if (cached.length) {
    state.messages = cached;
    renderMessages();
  }

  if (!state.isOnline) return;

  const {
    data,
    error,
  } = await supabase
    .from("messages")
    .select("*")
    .eq(
      "conversation_id",
      conversationId
    )
    .order("created_at", {
      ascending: true,
    });

  if (error) {
    console.error(
      "loadMessages failed:",
      error
    );
    return;
  }

  state.messages = data || [];

  renderMessages();

  await cacheMessages(
    conversationId,
    state.messages
  );
}

// ===============================================================
// REACTIONS
// ===============================================================

async function loadReactionsForConversation() {
  state.reactions = {};

  const ids =
    state.messages.map(
      (m) => m.id
    );

  if (!ids.length) return;

  const { data } = await supabase
    .from("message_reactions")
    .select("*")
    .in("message_id", ids);

  (data || []).forEach((r) => {
    if (!state.reactions[r.message_id]) {
      state.reactions[r.message_id] = [];
    }

    state.reactions[
      r.message_id
    ].push(r);
  });

  renderMessages();
}

// ===============================================================
// RENDER MESSAGES
// ===============================================================

function renderMessages() {
  const box =
    $("#chat-messages");

  if (!box) return;

  box.innerHTML = "";

  if (!state.messages.length) {
    box.innerHTML =
      `<div class="empty-chat">${state.t.no_messages}</div>`;

    return;
  }

  state.messages.forEach((m) => {
    box.appendChild(
      buildMessageBubble(m)
    );
  });

  box.scrollTop =
    box.scrollHeight;
}

function findMessageById(id) {
  return state.messages.find(
    (m) => m.id === id
  );
}

function messagePreviewText(m) {
  if (!m) return "";

  if (m.content) {
    return m.content;
  }

  if (m.attachment_type === "image") {
    return "📷 صورة";
  }

  if (m.attachment_type === "audio") {
    return "🎤 رسالة صوتية";
  }

  if (m.attachment_type === "video") {
    return "🎬 فيديو";
  }

  if (m.attachment_type === "file") {
    return "📎 ملف";
  }

  return "";
}

function isMessageMine(message) {
  if (!message || !state.me?.id) {
    return false;
  }

  return String(message.sender_id) === String(state.me.id);
}

function isMessageFromUser(message) {
  if (!message?.sender_id || !state.activeConversation) return false;
  const ordinaryUserId = state.me?.can_moderate
    ? state.activeConversation.userId
    : state.me.id;
  return String(message.sender_id) === String(ordinaryUserId);
}

// ===============================================================
// MESSAGE BUBBLE
// ===============================================================

function buildMessageBubble(m) {
  const mine = isMessageMine(m);
  const userSide = isMessageFromUser(m);

  const div =
    document.createElement("div");

  div.className =
    `bubble-row ${userSide ? "user-side" : "admin-side"} ${
      mine ? "mine" : "theirs"
    }`;

  div.dataset.messageId =
    m.id;

  const time =
    new Date(
      m.created_at
    ).toLocaleTimeString(
      state.lang === "ar"
        ? "ar-SA"
        : "en-US",
      {
        hour: "2-digit",
        minute: "2-digit",
      }
    );

  const ticks =
    mine
      ? m._pending
        ? '<span class="ticks">🕓</span>'
        : renderTicks(m.status)
      : "";

  const quoted =
    m.reply_to_id
      ? findMessageById(
          m.reply_to_id
        )
      : null;

  const quotedHtml =
    quoted
      ? `<div class="quoted-reply">${escapeHtml(
          messagePreviewText(quoted)
        )}</div>`
      : "";

  let attach = "";
  let mediaHint = "";

  if (m.attachment_url) {
    if (m.attachment_type === "image") {
      attach = `
        <img
          class="msg-attachment msg-image"
          src="${escapeHtml(m.attachment_url)}"
          alt="صورة مرفقة"
          loading="lazy"
          decoding="async"
          data-media-url="${escapeHtml(m.attachment_url)}"
          data-media-type="image"
        >
      `;
      mediaHint = `<div class="media-save-hint">اضغط مطولا لحفظ الصورة</div>`;
    } else if (m.attachment_type === "video") {
      attach = `
        <video
          class="msg-video"
          controls
          playsinline
          preload="metadata"
          src="${escapeHtml(m.attachment_url)}"
          data-media-url="${escapeHtml(m.attachment_url)}"
          data-media-type="video"
        ></video>
      `;
      mediaHint = `<div class="media-save-hint">اضغط مطولا لحفظ الفيديو</div>`;
    } else if (m.attachment_type === "audio") {
      attach = `
        <audio
          class="msg-audio"
          controls
          preload="metadata"
          src="${escapeHtml(m.attachment_url)}"
        ></audio>
      `;
    } else {
      attach = `
        <a
          class="msg-file"
          href="${escapeHtml(m.attachment_url)}"
          target="_blank"
          rel="noopener noreferrer"
        >
          📎 ${state.t.attach}
        </a>
      `;
    }
  }

  const reactions =
    state.reactions[m.id] || [];

  const grouped = {};

  reactions.forEach((r) => {
    grouped[r.emoji] =
      grouped[r.emoji] || {
        count: 0,
        mine: false,
      };

    grouped[r.emoji].count += 1;

    if (r.user_id === state.me.id) {
      grouped[r.emoji].mine = true;
    }
  });

  const reactionsHtml =
    Object.keys(grouped).length
      ? `
        <div class="reaction-bar">
          ${Object.entries(grouped)
            .map(
              ([emoji, g]) =>
                `
                <span
                  class="reaction-chip ${
                    g.mine ? "mine" : ""
                  }"
                  data-emoji="${escapeHtml(emoji)}"
                >
                  ${emoji} ${g.count}
                </span>
              `
            )
            .join("")}
        </div>
      `
      : "";

  let buttonsHtml = "";
  const canDeleteMessage = Boolean(isActiveChatModerator() && !m._pending);

  if (
    !mine &&
    Array.isArray(m.buttons) &&
    m.buttons.length
  ) {
    const used =
      state.clickedWelcomeButtons.has(
        m.id
      );

    buttonsHtml = `
      <div class="msg-buttons">
        ${m.buttons
          .map(
            (b) =>
              `
              <button
                type="button"
                class="msg-btn"
                data-value="${escapeHtml(
                  b.value
                )}"
                ${used ? "disabled" : ""}
              >
                ${escapeHtml(b.label)}
              </button>
            `
          )
          .join("")}
      </div>
    `;
  }

  div.innerHTML = `
    <div class="bubble">

      <div class="bubble-actions">
        <button
          class="bubble-action-reply"
          title="${state.t.reply}"
          type="button"
        >
          ↩
        </button>

        <button
          class="bubble-action-react"
          title="React"
          type="button"
        >
          😊
        </button>
        ${canDeleteMessage ? `<button class="bubble-action-delete" title="حذف الرسالة" type="button">🗑️</button>` : ""}
      </div>

      ${quotedHtml}
      ${attach}
      ${mediaHint}

      ${
        m.content
          ? `<div class="bubble-text">${escapeHtml(
              m.content
            )}</div>`
          : ""
      }

      <div class="bubble-meta">
        <span class="bubble-time">
          ${time}
        </span>
        ${ticks}
      </div>

      ${reactionsHtml}
      ${buttonsHtml}

      <div class="quick-react-panel hidden"></div>

    </div>
  `;

  div
    .querySelectorAll(".msg-btn")
    .forEach((btn) => {
      btn.addEventListener(
        "click",
        async () => {
          if (btn.disabled) return;

          state.clickedWelcomeButtons.add(
            m.id
          );

          div
            .querySelectorAll(".msg-btn")
            .forEach(
              (b) =>
                (b.disabled = true)
            );

          await sendMessage({
            content:
              btn.dataset.value,
          });
        }
      );
    });

  div
    .querySelector(
      ".bubble-action-reply"
    )
    ?.addEventListener(
      "click",
      () => setReplyTarget(m)
    );

  div.querySelector(".bubble-action-delete")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await deleteMessage(m);
  });

  const mediaElement = div.querySelector("[data-media-url]");
  if (mediaElement) {
    if (mediaElement.dataset.mediaType === "image") {
      mediaElement.addEventListener("click", () => {
        openMediaViewer(mediaElement.dataset.mediaUrl, "image");
      });
    }
    wireMediaLongPress(mediaElement, m);
  }

  wireMessageLongPress(div, canDeleteMessage);

  const reactBtn =
    div.querySelector(
      ".bubble-action-react"
    );

  const quickPanel =
    div.querySelector(
      ".quick-react-panel"
    );

  const quickEmojis = [
    "❤️",
    "👍",
    "😂",
    "😮",
    "😢",
    "🙏",
  ];

  if (quickPanel) {
    quickPanel.innerHTML =
      quickEmojis
        .map(
          (e) =>
            `
            <span
              class="quick-react-opt"
              data-emoji="${e}"
            >
              ${e}
            </span>
          `
        )
        .join("");

    reactBtn?.addEventListener(
      "click",
      () => {
        quickPanel.classList.toggle(
          "hidden"
        );
      }
    );

    quickPanel.addEventListener(
      "click",
      (e) => {
        const emoji =
          e.target.dataset.emoji;

        if (emoji) {
          toggleReaction(
            m.id,
            emoji
          );

          quickPanel.classList.add(
            "hidden"
          );
        }
      }
    );
  }

  div
    .querySelectorAll(".reaction-chip")
    .forEach((chip) => {
      chip.addEventListener(
        "click",
        () => {
          toggleReaction(
            m.id,
            chip.dataset.emoji
          );
        }
      );
    });

  wireSwipeToReply(div, m);

  return div;
}

function openMediaViewer(url, type) {
  const modal = $("#media-viewer-modal");
  const image = $("#media-viewer-image");
  const video = $("#media-viewer-video");
  if (!modal || !url) return;

  image?.classList.toggle("hidden", type !== "image");
  video?.classList.toggle("hidden", type !== "video");

  if (type === "image" && image) {
    image.src = url;
  }

  if (type === "video" && video) {
    video.src = url;
    video.currentTime = 0;
  }

  modal.classList.remove("hidden");
  document.body.classList.add("media-viewer-open");
}

function closeMediaViewer() {
  const modal = $("#media-viewer-modal");
  const image = $("#media-viewer-image");
  const video = $("#media-viewer-video");
  if (!modal) return;

  modal.classList.add("hidden");
  document.body.classList.remove("media-viewer-open");
  if (image) image.removeAttribute("src");
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

async function saveMediaAttachment(message) {
  const url = message?.attachment_url;
  if (!url) return;

  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) throw new Error("تعذّر تنزيل الميديا");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `whatsapp-${message.id || Date.now()}.${message.attachment_type === "video" ? "mp4" : "jpg"}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    showAuthError("تم حفظ الميديا على جهازك.");
  } catch (error) {
    // روابط Storage العامة قد تمنع fetch عبر CORS؛ نترك للمتصفح تنزيل الرابط مباشرة.
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "";
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    console.warn("تعذّر تنزيل الميديا مباشرة، تم فتح الرابط:", error);
  }
}

function wireMediaLongPress(mediaElement, message) {
  let timer = null;
  const start = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      event.preventDefault();
      saveMediaAttachment(message);
      if (navigator.vibrate) navigator.vibrate(15);
    }, 650);
  };
  const cancel = () => clearTimeout(timer);

  mediaElement.addEventListener("pointerdown", start);
  mediaElement.addEventListener("pointerup", cancel);
  mediaElement.addEventListener("pointercancel", cancel);
  mediaElement.addEventListener("pointerleave", cancel);
  mediaElement.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    saveMediaAttachment(message);
  });
}

function wireMessageLongPress(row, canDelete) {
  if (!canDelete) return;
  let timer = null;
  let longPressed = false;

  row.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, a, input, audio, video, img")) return;
    longPressed = false;
    timer = setTimeout(() => {
      longPressed = true;
      row.classList.add("long-pressed");
      if (navigator.vibrate) navigator.vibrate(15);
    }, 650);
  });

  ["pointerup", "pointercancel", "pointerleave"].forEach((name) => {
    row.addEventListener(name, () => clearTimeout(timer));
  });

  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    row.classList.add("long-pressed");
  });
}

async function deleteMessage(message) {
  if (!isActiveChatModerator() || !message?.id || message._pending) return;
  if (!window.confirm("هل تريد حذف هذه الرسالة؟")) return;

  const { error } = await supabase.rpc("delete_message_as_moderator", {
    p_message_id: message.id,
  });
  if (error) {
    showAuthError("تعذّر حذف الرسالة: " + error.message);
    return;
  }

  state.messages = state.messages.filter((item) => item.id !== message.id);
  await deleteCachedMessage(message.id);
  delete state.reactions[message.id];
  renderMessages();
  await cacheMessages(state.activeConversation.id, state.messages);
}

async function deleteUser(profile) {
  if (!state.me?.is_admin || !profile?.id) return;
  if (!window.confirm(`حذف المستخدم ${profile.display_name || ""}؟ سيتم حذف محادثاته ورسائله.`)) return;
  const { error } = await supabase.functions.invoke("admin-delete-user", { body: { userId: profile.id } });
  if (error) { showAuthError("تعذّر حذف المستخدم: " + error.message); return; }
  if (state.activeConversation?.userId === profile.id) closeChatView();
  await loadContacts();
  showAuthError("تم حذف المستخدم.");
}

async function getConversationRecipientId(conversationId, senderId) {
  const { data: conversation, error } = await supabase
    .from("conversations")
    .select("user_id, admin_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !conversation) return null;
  return String(senderId) === String(conversation.user_id)
    ? conversation.admin_id
    : conversation.user_id;
}

async function sendPushForMessage(message, receiverId) {
  try {
    const { error } = await supabase.functions.invoke("send-push", {
      body: { record: { ...message, receiver_id: receiverId } },
    });
    if (error) console.warn("Push invoke failed:", error.message);
  } catch (error) {
    console.warn("Push invoke failed:", error);
  }
}

// ===============================================================
// SWIPE TO REPLY
// ===============================================================

function wireSwipeToReply(row, message) {
  const bubble =
    row.querySelector(".bubble");

  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dragging = false;
  let horizontalLock = false;

  const THRESHOLD = 60;

  row.addEventListener(
    "touchstart",
    (e) => {
      startX =
        e.touches[0].clientX;

      startY =
        e.touches[0].clientY;

      dx = 0;
      dragging = true;
      horizontalLock = false;
    },
    { passive: true }
  );

  row.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return;

      const touch =
        e.touches[0];

      const deltaX =
        touch.clientX -
        startX;

      const deltaY =
        touch.clientY -
        startY;

      if (!horizontalLock) {
        if (
          Math.abs(deltaX) > 10 ||
          Math.abs(deltaY) > 10
        ) {
          horizontalLock =
            Math.abs(deltaX) >
            Math.abs(deltaY);
        }

        if (!horizontalLock) return;
      }

      e.preventDefault();

      dx = Math.max(
        -90,
        Math.min(90, deltaX)
      );

      bubble.style.transform =
        `translateX(${dx}px)`;

      bubble.style.transition =
        "none";

      row.classList.toggle(
        "swipe-armed",
        Math.abs(dx) > THRESHOLD
      );
    },
    { passive: false }
  );

  row.addEventListener(
    "touchend",
    () => {
      if (!dragging) return;

      dragging = false;

      bubble.style.transition =
        "transform .2s ease";

      bubble.style.transform =
        "translateX(0)";

      row.classList.remove(
        "swipe-armed"
      );

      if (
        horizontalLock &&
        Math.abs(dx) > THRESHOLD
      ) {
        setReplyTarget(message);

        if (navigator.vibrate) {
          navigator.vibrate(15);
        }
      }

      dx = 0;
    }
  );
}

// ===============================================================
// TICKS
// ===============================================================

function renderTicks(status) {
  if (status === "read") {
    return `
      <span class="ticks ticks-read">
        ✓✓
      </span>
    `;
  }

  if (status === "delivered") {
    return `
      <span class="ticks">
        ✓✓
      </span>
    `;
  }

  return `
    <span class="ticks">
      ✓
    </span>
  `;
}

// ===============================================================
// REPLY
// ===============================================================

function setReplyTarget(m) {
  state.replyingTo = m;

  $("#reply-preview-text").textContent =
    messagePreviewText(m);

  $("#reply-preview-bar")?.classList.remove(
    "hidden"
  );

  $("#composer-input")?.focus();
}

function clearReply() {
  state.replyingTo = null;

  $("#reply-preview-bar")?.classList.add(
    "hidden"
  );
}

// ===============================================================
// REACTIONS
// ===============================================================

async function toggleReaction(
  messageId,
  emoji
) {
  const existing =
    (
      state.reactions[messageId] || []
    ).find(
      (r) =>
        r.user_id === state.me.id &&
        r.emoji === emoji
    );

  if (existing) {
    await supabase
      .from("message_reactions")
      .delete()
      .eq("id", existing.id);
  } else {
    await supabase
      .from("message_reactions")
      .insert({
        message_id: messageId,
        user_id: state.me.id,
        emoji,
      });
  }

  await loadReactionsForConversation();
}

// ===============================================================
// MEDIA
// ===============================================================

function getSafeFileExtension(
  file,
  forcedExtension = null
) {
  if (forcedExtension) {
    return forcedExtension
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase();
  }

  const mime =
    (file?.type || "").toLowerCase();

  const mimeMap = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
  };

  if (mimeMap[mime]) {
    return mimeMap[mime];
  }

  const match =
    (file?.name || "").match(
      /\.([a-zA-Z0-9]+)$/
    );

  if (match) {
    const ext =
      match[1]
        .toLowerCase()
        .replace(
          /[^a-z0-9]/g,
          ""
        );

    if (ext) return ext;
  }

  return "bin";
}

function createUploadUUID() {
  if (
    window.crypto &&
    typeof window.crypto.randomUUID ===
      "function"
  ) {
    return window.crypto.randomUUID();
  }

  return (
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
  ).replace(
    /[xy]/g,
    (c) => {
      const r =
        (Math.random() * 16) | 0;

      const v =
        c === "x"
          ? r
          : (r & 0x3) | 0x8;

      return v.toString(16);
    }
  );
}

async function uploadMediaToSupabase(
  file,
  options = {}
) {
  if (!file) {
    throw new Error("لم يتم اختيار ملف");
  }

  if (!state.me) {
    throw new Error(
      "يجب تسجيل الدخول أولاً"
    );
  }

  if (!state.isOnline) {
    throw new Error(
      "لا يمكن رفع الوسائط أثناء عدم الاتصال بالإنترنت"
    );
  }

  const bucket =
    options.bucket || "attachments";

  const folder =
    options.folder || state.me.id;

  const extension =
    getSafeFileExtension(
      file,
      options.extension
    );

  const uuid =
    createUploadUUID();

  const storagePath =
    `${folder}/${uuid}.${extension}`;

  const contentType =
    file.type ||
    options.contentType ||
    "application/octet-stream";

  const { error } =
    await supabase
      .storage
      .from(bucket)
      .upload(
        storagePath,
        file,
        {
          cacheControl: "3600",
          contentType,
          upsert: false,
        }
      );

  if (error) throw error;

  const {
    data: publicData,
  } =
    supabase
      .storage
      .from(bucket)
      .getPublicUrl(
        storagePath
      );

  const publicUrl =
    publicData?.publicUrl;

  if (!publicUrl) {
    throw new Error(
      "تم رفع الملف ولكن تعذر الحصول على الرابط العام"
    );
  }

  return {
    path: storagePath,
    publicUrl,
    contentType,
    extension,
  };
}

// ===============================================================
// MEDIA UI
// ===============================================================

function getMediaUploadStatusElement() {
  if (
    state.mediaUploadStatusElement &&
    document.body.contains(
      state.mediaUploadStatusElement
    )
  ) {
    return state.mediaUploadStatusElement;
  }

  let el =
    document.querySelector(
      "#media-upload-status"
    );

  if (!el) {
    el =
      document.createElement("div");

    el.id =
      "media-upload-status";

    el.className =
      "media-upload-status hidden";

    el.setAttribute(
      "role",
      "status"
    );

    el.setAttribute(
      "aria-live",
      "polite"
    );

    const composer =
      document.querySelector(
        "#composer-form"
      );

    if (composer) {
      composer.appendChild(el);
    } else {
      document.body.appendChild(el);
    }
  }

  state.mediaUploadStatusElement =
    el;

  return el;
}

function setMediaUploadingState(
  active,
  message = ""
) {
  state.mediaUploading =
    active;

  const status =
    getMediaUploadStatusElement();

  status.textContent =
    message ||
    "جاري رفع الوسائط...";

  status.classList.toggle(
    "hidden",
    !active
  );

  const attachInput =
    $("#attach-input");

  if (attachInput) {
    attachInput.disabled =
      active;
  }

  const micBtn =
    $("#mic-btn");

  if (micBtn) {
    micBtn.disabled =
      active;
  }

  const submitBtn =
    $("#composer-form button[type='submit']");

  if (submitBtn) {
    submitBtn.disabled =
      active;
  }

  document.body.classList.toggle(
    "media-uploading",
    active
  );
}

// ===============================================================
// SEND MESSAGE
// ===============================================================

async function sendMessage({
  content,
  attachmentFile = null,
  attachmentType = null,
  attachmentUrl = null,
  attachmentExtension = null,
}) {
  const conv =
    state.activeConversation;

  if (!conv || state.mediaUploading) {
    return;
  }

  const replyToId =
    state.replyingTo?.id || null;

  if (
    !state.isOnline &&
    !attachmentFile &&
    !attachmentUrl
  ) {
    const optimistic = {
      id: `local-${Date.now()}`,
      conversation_id: conv.id,
      sender_id: state.me.id,
      content: content || null,
      attachment_url: null,
      attachment_type: null,
      reply_to_id: replyToId,
      status: "pending",
      created_at:
        new Date().toISOString(),
      _pending: true,
    };

    state.messages.push(optimistic);

    renderMessages();

    await queueOutboxMessage({
      conversation_id: conv.id,
      sender_id: state.me.id,
      content: content || null,
      attachment_url: null,
      attachment_type: null,
      reply_to_id: replyToId,
    });

    clearReply();
    return;
  }

  if (!state.isOnline && attachmentFile) {
    showAuthError(
      "لا يمكن رفع الصورة أو الوسائط بدون اتصال بالإنترنت. أعد المحاولة بعد عودة الاتصال."
    );

    return;
  }

  let finalAttachmentUrl =
    attachmentUrl;

  let finalAttachmentType =
    attachmentType;

  if (attachmentFile) {
    try {
      setMediaUploadingState(
        true,
        attachmentType === "image"
          ? "جاري رفع الصورة، يرجى الانتظار..."
          : attachmentType === "video"
          ? "جاري رفع الفيديو، يرجى الانتظار..."
          : attachmentType === "audio"
          ? "جاري رفع الرسالة الصوتية، يرجى الانتظار..."
          : "جاري رفع الملف، يرجى الانتظار..."
      );

      const uploaded =
        await uploadMediaToSupabase(
          attachmentFile,
          {
            bucket: "attachments",
            folder: state.me.id,
            extension:
              attachmentExtension,
            contentType:
              attachmentFile.type,
          }
        );

      finalAttachmentUrl =
        uploaded.publicUrl;

      finalAttachmentType =
        attachmentType ||
        (
          attachmentFile.type.startsWith(
            "image/"
          )
            ? "image"
            : attachmentFile.type.startsWith(
                "audio/"
              )
            ? "audio"
            : "file"
        );
    } catch (error) {
      console.error(
        "Media upload failed:",
        error
      );

      showAuthError(
        "فشل رفع الوسائط: " +
          (
            error?.message ||
            "خطأ غير معروف"
          )
      );

      return;
    } finally {
      setMediaUploadingState(false);
    }
  }

  if (
    attachmentFile &&
    !finalAttachmentUrl
  ) {
    showAuthError(
      "لم يكتمل رفع الوسائط، لذلك لم يتم إرسال الرسالة."
    );

    return;
  }

  const {
    data: insertedMessage,
    error,
  } = await supabase
    .from("messages")
    .insert({
      conversation_id: conv.id,
      sender_id: state.me.id,
      content: content || null,
      attachment_url:
        finalAttachmentUrl || null,
      attachment_type:
        finalAttachmentType || null,
      reply_to_id: replyToId,
      status: "sent",
    })
    .select()
    .single();

  if (error) {
    showAuthError(error.message);
    return;
  }

  // =============================================================
  // LIVE: تحديث الرسالة في القائمة فور نجاح INSERT
  // =============================================================

  if (insertedMessage) {
    const recipientId = await getConversationRecipientId(conv.id, state.me.id);
    if (recipientId && recipientId !== state.me.id) {
      await sendPushForMessage(insertedMessage, recipientId);
    }

    const exists =
      state.messages.some(
        (m) =>
          m.id === insertedMessage.id
      );

    if (!exists && state.activeConversation?.id === conv.id) {
      state.messages.push(
        insertedMessage
      );

      renderMessages();

      await cacheMessages(
        conv.id,
        [insertedMessage]
      );
    }

    await patchContactUIOnNewMessage(
      insertedMessage,
      {
        incrementUnread: false,
      }
    );
  }

  const preview =
    content ||
    messagePreviewText({
      attachment_type:
        finalAttachmentType,
    });

  try {
    const {
      error: convUpdateError,
    } = await supabase
      .from("conversations")
      .update({
        last_message: preview,
        last_message_at:
          new Date().toISOString(),
      })
      .eq("id", conv.id);

    if (convUpdateError) {
      console.error(
        "تعذّر تحديث معاينة آخر رسالة:",
        convUpdateError
      );
    }
  } catch (err) {
    console.error(
      "خطأ شبكة أثناء تحديث المحادثة:",
      err
    );
  }

  clearReply();

  await setTyping(false);
}

// ===============================================================
// ATTACHMENT
// ===============================================================

async function handleAttachmentUpload(e) {
  const file =
    e.target.files?.[0];

  const resetInput = () => {
    e.target.value = "";
  };

  if (
    !file ||
    !state.activeConversation
  ) {
    resetInput();
    return;
  }

  if (state.mediaUploading) {
    resetInput();
    return;
  }

  let type = "file";

  if (
    file.type &&
    file.type.startsWith("image/")
  ) {
    type = "image";
  } else if (
    file.type &&
    file.type.startsWith("video/")
  ) {
    type = "video";
  } else if (
    file.type &&
    file.type.startsWith("audio/")
  ) {
    type = "audio";
  }

  await sendMessage({
    content: null,
    attachmentFile: file,
    attachmentType: type,
  });

  resetInput();
}

// ===============================================================
// AVATAR
// ===============================================================

function getStoragePath(bucket, publicUrl) {
  if (!publicUrl) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const index = publicUrl.indexOf(marker);
  return index === -1 ? null : decodeURIComponent(publicUrl.slice(index + marker.length));
}

async function removeStorageFile(bucket, publicUrl) {
  const path = getStoragePath(bucket, publicUrl);
  if (!path) return;
  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error) console.warn(`تعذّر حذف ملف ${bucket} من Storage:`, error.message);
}

async function removeAvatar() {
  if (!state.me?.id) return;
  const previousUrl = state.me.avatar_url;
  try {
    const { error } = await supabase.from("profiles").update({ avatar_url: null }).eq("id", state.me.id);
    if (error) throw error;
    state.me.avatar_url = null;
    await removeStorageFile("avatars", previousUrl);
    $("#my-avatar")?.removeAttribute("src");
    showAuthError("تم حذف الصورة الشخصية.");
  } catch (error) {
    showAuthError("تعذّر حذف الصورة الشخصية: " + (error?.message || "خطأ غير معروف"));
  }
}

async function removeWallpaper() {
  if (!state.me?.id) return;
  const previousUrl = state.me.wallpaper_url;
  try {
    const { error } = await supabase.from("profiles").update({ wallpaper_url: null }).eq("id", state.me.id);
    if (error) throw error;
    state.me.wallpaper_url = null;
    await removeStorageFile("wallpapers", previousUrl);
    applyThemeVars();
    showAuthError("تم حذف خلفية الدردشة.");
  } catch (error) {
    showAuthError("تعذّر حذف خلفية الدردشة: " + (error?.message || "خطأ غير معروف"));
  }
}

async function handleAvatarUpload(e) {
  const file =
    e.target.files?.[0];

  if (!file) return;

  try {
    setMediaUploadingState(
      true,
      "جاري رفع الصورة الشخصية..."
    );

    const uploaded =
      await uploadMediaToSupabase(
        file,
        {
          bucket: "avatars",
          folder: state.me.id,
        }
      );

    await supabase
      .from("profiles")
      .update({
        avatar_url:
          uploaded.publicUrl,
      })
      .eq(
        "id",
        state.me.id
      );

    state.me.avatar_url =
      uploaded.publicUrl;

    if ($("#my-avatar")) {
      $("#my-avatar").src =
        uploaded.publicUrl;
    }
  } catch (error) {
    console.error(
      "Avatar upload failed:",
      error
    );

    showAuthError(
      "فشل رفع الصورة الشخصية: " +
        (
          error?.message ||
          "خطأ غير معروف"
        )
    );
  } finally {
    setMediaUploadingState(false);
    e.target.value = "";
  }
}

// ===============================================================
// WALLPAPER
// ===============================================================

async function handleWallpaperUpload(e) {
  const file =
    e.target.files?.[0];

  if (!file) return;

  try {
    setMediaUploadingState(
      true,
      "جاري رفع خلفية المحادثة..."
    );

    const uploaded =
      await uploadMediaToSupabase(
        file,
        {
          bucket: "wallpapers",
          folder: state.me.id,
        }
      );

    await supabase
      .from("profiles")
      .update({
        wallpaper_url:
          uploaded.publicUrl,
      })
      .eq(
        "id",
        state.me.id
      );

    state.me.wallpaper_url =
      uploaded.publicUrl;

    applyThemeVars();
  } catch (error) {
    console.error(
      "Wallpaper upload failed:",
      error
    );

    showAuthError(
      "فشل رفع خلفية المحادثة: " +
        (
          error?.message ||
          "خطأ غير معروف"
        )
    );
  } finally {
    setMediaUploadingState(false);
    e.target.value = "";
  }
}

// ===============================================================
// VOICE
// ===============================================================

async function toggleRecording() {
  if (state.recording) {
    await stopAndSendRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  if (!state.activeConversation) return;

  if (
    !navigator.mediaDevices ||
    !window.MediaRecorder
  ) {
    showAuthError(
      "التسجيل الصوتي غير مدعوم في هذا المتصفح"
    );

    return;
  }

  if (!state.isOnline) {
    showAuthError(
      "لا يمكن رفع الرسالة الصوتية أثناء عدم الاتصال بالإنترنت."
    );

    return;
  }

  try {
    const stream =
      await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

    const mediaRecorder =
      new MediaRecorder(stream);

    const chunks = [];

    mediaRecorder.ondataavailable =
      (e) => {
        if (e.data?.size) {
          chunks.push(e.data);
        }
      };

    mediaRecorder.start();

    state.recording = {
      mediaRecorder,
      chunks,
      stream,
      seconds: 0,
      timerInterval: null,
    };

    $("#recording-bar")?.classList.remove(
      "hidden"
    );

    $("#composer-input")?.classList.add(
      "hidden"
    );

    $("#mic-btn").textContent =
      "✅";

    $("#mic-btn")?.classList.add(
      "recording-active"
    );

    state.recording.timerInterval =
      setInterval(() => {
        if (!state.recording) return;

        state.recording.seconds += 1;

        const mm =
          String(
            Math.floor(
              state.recording.seconds /
                60
            )
          ).padStart(2, "0");

        const ss =
          String(
            state.recording.seconds %
              60
          ).padStart(2, "0");

        $("#recording-timer").textContent =
          `${mm}:${ss}`;
      }, 1000);
  } catch (err) {
    console.error(
      "Microphone error:",
      err
    );

    showAuthError(
      "لم يتم منح إذن الوصول للميكروفون"
    );
  }
}

async function stopAndSendRecording() {
  const rec =
    state.recording;

  if (!rec) return;

  const blob =
    await finalizeRecording(rec);

  resetRecordingUI();

  if (!blob) return;

  await sendMessage({
    content: null,
    attachmentFile: blob,
    attachmentType: "audio",
    attachmentExtension: "webm",
  });
}

function cancelRecording() {
  const rec =
    state.recording;

  if (!rec) return;

  finalizeRecording(rec, true);
  resetRecordingUI();
}

function finalizeRecording(
  rec,
  discard = false
) {
  return new Promise((resolve) => {
    clearInterval(
      rec.timerInterval
    );

    rec.mediaRecorder.onstop =
      () => {
        rec.stream
          .getTracks()
          .forEach((t) => t.stop());

        if (discard) {
          resolve(null);
          return;
        }

        const mime =
          rec.mediaRecorder.mimeType ||
          "audio/webm";

        resolve(
          new Blob(
            rec.chunks,
            { type: mime }
          )
        );
      };

    if (
      rec.mediaRecorder.state !==
      "inactive"
    ) {
      rec.mediaRecorder.stop();
    } else {
      resolve(null);
    }
  });
}

function resetRecordingUI() {
  state.recording = null;

  $("#recording-bar")?.classList.add(
    "hidden"
  );

  if ($("#recording-timer")) {
    $("#recording-timer").textContent =
      "00:00";
  }

  $("#composer-input")?.classList.remove(
    "hidden"
  );

  if ($("#mic-btn")) {
    $("#mic-btn").textContent =
      "🎤";

    $("#mic-btn").classList.remove(
      "recording-active"
    );
  }
}

// ===============================================================
// OUTBOX
// ===============================================================

async function flushOutbox() {
  const pending =
    await getOutbox();

  if (!pending.length) return;

  for (const item of pending) {
    const {
      local_id,
      queued_at,
      ...msg
    } = item;

    const {
      data: inserted,
      error,
    } = await supabase
      .from("messages")
      .insert({
        ...msg,
        status: "sent",
      })
      .select()
      .single();

    if (!error) {
      await removeFromOutbox(local_id);

      try {
        await supabase
          .from("conversations")
          .update({
            last_message:
              msg.content ||
              messagePreviewText({
                attachment_type:
                  msg.attachment_type,
              }),
            last_message_at:
              new Date().toISOString(),
          })
          .eq(
            "id",
            msg.conversation_id
          );
      } catch (err) {
        console.error(
          "Outbox conversation update failed:",
          err
        );
      }

      if (inserted) {
        const recipientId = await getConversationRecipientId(msg.conversation_id, msg.sender_id);
        if (recipientId && recipientId !== state.me?.id) {
          await sendPushForMessage(inserted, recipientId);
        }
        await patchContactUIOnNewMessage(
          inserted,
          {
            incrementUnread: false,
          }
        );
      }
    }
  }

  if (state.activeConversation) {
    state.messages =
      state.messages.filter(
        (m) => !m._pending
      );

    await loadMessages(
      state.activeConversation.id
    );
  }
}

// ===============================================================
// REALTIME RESUBSCRIBE
// ===============================================================

function scheduleRealtimeReconnect(status) {
  if (!state.me || state.realtimeReconnectTimer) return;

  if (!state.isOnline ||
      (status !== "CHANNEL_ERROR" &&
       status !== "TIMED_OUT")) {
    return;
  }

  console.warn("Realtime channel lost:", status);

  state.realtimeReconnectTimer = setTimeout(() => {
    state.realtimeReconnectTimer = null;
    resubscribeRealtime();
    loadContacts();
  }, 1500);
}

function removeRealtimeChannel(channel) {
  if (!channel) return;

  try {
    supabase.removeChannel(channel);
  } catch (err) {
    console.error(
      "removeRealtimeChannel failed:",
      err
    );
  }
}

function resubscribeRealtime() {
  if (!state.me) return;

  removeRealtimeChannel(
    state.presenceChannel
  );

  state.presenceChannel = null;
  subscribeGlobalPresence();

  removeRealtimeChannel(
    state.inboxChannel
  );

  state.inboxChannel = null;
  subscribeInboxUpdates();

  removeRealtimeChannel(
    state.globalMsgChannel
  );

  state.globalMsgChannel = null;
  subscribeGlobalMessageWatch();

  if (state.activeConversation) {
    subscribeToConversation(
      state.activeConversation.id
    );

    loadMessages(
      state.activeConversation.id
    );
  }
}

// ===============================================================
// REALTIME CONVERSATION
// ===============================================================

function subscribeToConversation(
  conversationId
) {
  removeRealtimeChannel(
    state.msgChannel
  );

  removeRealtimeChannel(
    state.typingChannel
  );

  removeRealtimeChannel(
    state.reactionsChannel
  );

  state.msgChannel =
    supabase
      .channel(
        `messages:${conversationId}`
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter:
            `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          const message = payload.new;
          const isIncoming = String(message.sender_id) !== String(state.me.id);
          const receivedMessage = isIncoming && message.status === "sent"
            ? { ...message, status: "delivered" }
            : message;

          if (isIncoming && message.status === "sent") {
            persistDeliveredStatus(message.id);
          }

          // =======================================================
          // LIVE CHAT APPEND
          // =======================================================

          const exists =
            state.messages.some(
              (m) =>
                m.id === receivedMessage.id
            );

          if (!exists) {
            state.messages.push(receivedMessage);

            renderMessages();

            await cacheMessages(
              conversationId,
              [receivedMessage]
            );
          }

          // =======================================================
          // LIVE CONTACT PATCH
          // =======================================================

          await patchContactUIOnNewMessage(
            message,
            {
              incrementUnread:
                message.sender_id !==
                state.me.id,
            }
          );

          if (isIncoming) {
            playNotificationSound();

            // المحادثة مفتوحة، لذلك لا نزيد العداد.
            clearUnreadBadge(
              conversationId
            );

            await markConversationRead(
              conversationId
            );
          }
        }
      )
        .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          state.messages = state.messages.filter((item) => item.id !== payload.old.id);
          await deleteCachedMessage(payload.old.id);
          renderMessages();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter:
            `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const idx =
            state.messages.findIndex(
              (m) =>
                m.id ===
                payload.new.id
            );

          if (idx > -1) {
            state.messages[idx] =
              payload.new;
          }

          renderMessages();
        }
      )
      .subscribe((status) => {
        scheduleRealtimeReconnect(status);
      });

  // =============================================================
  // TYPING
  // =============================================================

  state.typingChannel =
    supabase
      .channel(
        `typing:${conversationId}`
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "typing_status",
          filter:
            `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row =
            payload.new;

          if (
            row &&
            row.user_id !==
              state.me.id
          ) {
            $("#typing-indicator")?.classList.toggle(
              "hidden",
              !row.is_typing
            );
          }
        }
      )
      .subscribe((status) => {
        scheduleRealtimeReconnect(status);
      });

  // =============================================================
  // REACTIONS
  // =============================================================

  state.reactionsChannel =
    supabase
      .channel(
        `reactions:${conversationId}`
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "message_reactions",
        },
        (payload) => {
          const row =
            payload.new ||
            payload.old;

          if (
            row &&
            state.messages.some(
              (m) =>
                m.id ===
                row.message_id
            )
          ) {
            loadReactionsForConversation();
          }
        }
      )
      .subscribe((status) => {
        scheduleRealtimeReconnect(status);
      });
}

// ===============================================================
// MESSAGE DELIVERY / READ STATUS
// ===============================================================

async function persistDeliveredStatus(messageId) {
  if (!state.me || !messageId) return;

  const { error } = await supabase
    .from("messages")
    .update({ status: "delivered" })
    .eq("id", messageId)
    .neq("sender_id", state.me.id)
    .eq("status", "sent");

  if (error) {
    console.warn("persistDeliveredStatus failed:", error.message);
  }
}

// ===============================================================
// MARK READ
// ===============================================================

async function markConversationRead(
  conversationId
) {
  if (!state.me || !conversationId) {
    return;
  }

  try {
    const { error } =
      await supabase
        .from("messages")
        .update({
          status: "read",
        })
        .eq(
          "conversation_id",
          conversationId
        )
        .neq(
          "sender_id",
          state.me.id
        )
        .neq(
          "status",
          "read"
        );

    if (error) {
      console.error(
        "markConversationRead failed:",
        error
      );
    }
  } catch (err) {
    console.error(
      "markConversationRead network error:",
      err
    );
  }

  // =============================================================
  // LIVE: تصفير الشارة حتى لو لم يكن هناك صف في DOM سابقاً
  // =============================================================

  clearUnreadBadge(
    conversationId
  );
}

// ===============================================================
// TYPING
// ===============================================================

function handleTypingInput() {
  if (!state.isOnline || !state.activeConversation?.id) return;

  setTyping(true);

  clearTimeout(
    state.typingTimeout
  );

  state.typingTimeout =
    setTimeout(
      () => setTyping(false),
      2000
    );
}

async function setTyping(isTyping) {
  const conv =
    state.activeConversation;

  if (!conv?.id || !state.me || !state.isOnline) return;

  try {
    const { error } = await supabase
      .from("typing_status")
      .upsert(
        {
          conversation_id:
            conv.id,
          user_id:
            state.me.id,
          is_typing:
            isTyping,
          updated_at:
            new Date().toISOString(),
        },
        {
          onConflict:
            "conversation_id,user_id",
        }
      );

    if (error) {
      console.warn(
        "Typing status skipped due to Supabase permissions/network:",
        error?.message || error
      );
    }
  } catch (err) {
    console.warn(
      "setTyping failed (non-fatal):",
      err?.message || err
    );
  }
}

// ===============================================================
// GLOBAL PRESENCE
// ===============================================================

function subscribeGlobalPresence() {
  if (!state.me) return;

  state.presenceChannel =
    supabase.channel(
      "presence:global",
      {
        config: {
          presence: {
            key: state.me.id,
          },
        },
      }
    );

  state.presenceChannel
    .on(
      "presence",
      {
        event: "sync",
      },
      () => {
        const presState =
          state.presenceChannel.presenceState();

        state.onlineMap = {};

        Object.keys(
          presState
        ).forEach(
          (id) =>
            (state.onlineMap[id] =
              true)
        );

        if (
          state.activeConversation
        ) {
          refreshPresenceLabel(
            state.activeConversation
              .otherProfile.id
          );
        }
      }
    )
    .on(
      "presence",
      {
        event: "leave",
      },
      async ({
        leftPresences,
      }) => {
        if (
          state.activeConversation
        ) {
          const leftIds =
            leftPresences
              .map(
                (p) =>
                  p.presence_ref &&
                  p.key
              )
              .filter(Boolean);

          if (
            leftIds.includes(
              state.activeConversation
                .otherProfile.id
            )
          ) {
            await refreshPresenceLabel(
              state.activeConversation
                .otherProfile.id
            );
          }
        }
      }
    )
    .subscribe(
      async (status) => {
      scheduleRealtimeReconnect(status);

        if (
          status ===
          "SUBSCRIBED"
        ) {
          await state.presenceChannel.track(
            {
              online_at:
                new Date().toISOString(),
            }
          );
        }
      }
    );
}

// ===============================================================
// PRESENCE LABEL
// ===============================================================

async function refreshPresenceLabel(
  otherId
) {
  const label =
    $("#chat-header-status");

  if (!label) return;

  if (
    state.onlineMap[otherId]
  ) {
    label.textContent =
      state.t.online;

    return;
  }

  let profile = null;

  try {
    const {
      data,
      error,
    } = await supabase
      .from("profiles")
      .select("last_seen")
      .eq("id", otherId)
      .single();

    if (error) {
      console.error(
        "refreshPresenceLabel failed:",
        error
      );
    } else {
      profile = data;
    }
  } catch (err) {
    console.error(
      "refreshPresenceLabel network error:",
      err
    );
  }

  if (profile?.last_seen) {
    const d =
      new Date(
        profile.last_seen
      );

    const time =
      d.toLocaleTimeString(
        state.lang === "ar"
          ? "ar-SA"
          : "en-US",
        {
          hour: "2-digit",
          minute: "2-digit",
        }
      );

    const dateLabel =
      d.toDateString() ===
      new Date().toDateString()
        ? time
        : d.toLocaleDateString(
            state.lang === "ar"
              ? "ar-SA"
              : "en-US"
          ) +
          " " +
          time;

    label.textContent =
      `${state.t.last_seen} ${dateLabel}`;
  } else {
    label.textContent = "";
  }
}

// ===============================================================
// INBOX REALTIME
// ===============================================================

function subscribeInboxUpdates() {
  if (!state.me) return;

  state.inboxChannel =
    supabase
      .channel("inbox-updates")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
        },
        (payload) => {
          const row =
            payload.new;

          if (!row) return;

          if (
            row.user_id ===
              state.me.id ||
            row.admin_id ===
              state.me.id
          ) {
            // =====================================================
            // LIVE: تحديث صف المحادثة بدلاً من إعادة تحميل القائمة
            // =====================================================

            if (
              payload.eventType ===
                "UPDATE" ||
              payload.eventType ===
                "INSERT"
            ) {
              patchContactUIOnConversationUpdate(
                row
              );
            }
          }
        }
      )
      .subscribe((status) => {
        scheduleRealtimeReconnect(status);
      });
}

// ===============================================================
// GLOBAL MESSAGE WATCH
// ===============================================================

function subscribeGlobalMessageWatch() {
  if (!state.me) {
    return;
  }

  state.globalMsgChannel =
    supabase
      .channel(
        "global-messages-watch"
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        async (payload) => {
          const msg =
            payload.new;

          if (
            msg.sender_id ===
            state.me.id
          ) {
            // حتى الرسالة الخاصة بنا يجب أن تحدّث preview
            await patchContactUIOnNewMessage(
              msg,
              {
                incrementUnread: false,
              }
            );

            return;
          }

          const isActive =
            state.activeConversation &&
            msg.conversation_id ===
              state.activeConversation.id;

          // ========================================================
          // LIVE UI PATCH
          // ========================================================

          await patchContactUIOnNewMessage(
            msg,
            {
              incrementUnread:
                !isActive,
            }
          );

          // ========================================================
          // إذا كانت المحادثة مفتوحة، تتم إضافتها داخل الشات
          // من subscribeToConversation، لذلك لا نكررها هنا.
          // ========================================================

          if (isActive) {
            clearUnreadBadge(msg.conversation_id);
            if (msg.status === "sent") persistDeliveredStatus(msg.id);
            return;
          }

          if (msg.status === "sent") {
            persistDeliveredStatus(msg.id);
          }

          playNotificationSound();
        }
      )
      .subscribe((status) => {
        scheduleRealtimeReconnect(status);
      });
}

// ===============================================================
// NOTIFICATION SOUND
// ===============================================================

function playNotificationSound() {
  const audio =
    $("#notification-sound");

  audio
    ?.play()
    .catch(() => {});
}

// ===============================================================
// EMOJI PICKER
// ===============================================================

function wireEmojiPicker() {
  const btn =
    $("#emoji-toggle");

  const panel =
    $("#emoji-panel");

  if (!btn || !panel) return;

  if (panel.dataset.wired === "1") {
    return;
  }

  panel.dataset.wired = "1";

  const emojis = [
    "😀","😃","😄","😁","😆","😅","😂","🤣","🥲","🥹",
    "☺️","😊","😇","🙂","🙃","😉","😌","😍","🥰","😘",
    "😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐",
    "🤓","😎","🥸","🤩","🥳","😏","😒","😞","😔","😟",
    "😕","🙁","☹️","😣","😖","😫","😩","🥺","😢","😭",
    "😮‍💨","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱",
    "😨","😰","😥","😓","🫣","🤗","🫡","🤔","🤫","🫠",
    "🤥","😶","😶‍🌫️","😐","😑","😬","🫨","😯","😦","😧",
    "😮","😲","🥱","😴","🤤","😪","😵","😵‍💫","🤐","🥴",
    "🤢","🤮","🤧","😷","🤒",
    "👍","👎","👏","🙌","🫶","👐","🤲","🤝","🙏","✍️",
    "💅","🤳","💪","🦾","🖐️","✋","🤚","👋","🤙","🤌",
    "🤏","👌","🫰","✌️","🤞","🤟","🤘","👈","👉","👆",
    "🖕","👇","☝️","🫵","🤜","🤛",
    "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔",
    "❤️‍🔥","❤️‍🩹","❣️","💕","💞","💓","💗","💖","💘","💝",
    "🫀","✨","💥","🔥",
    "🎉","🎊","🎈","🎂","🎁","⭐","🌟","💫","💯","✅",
    "❌","⚠️","☕","🍕","🍔","🍟","⚽","🏀","🚀","📱",
    "💻","📸","🎵","🎧",
  ];

  panel.innerHTML =
    emojis
      .map(
        (e) =>
          `<span class="emoji-opt">${e}</span>`
      )
      .join("");

  btn.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();

      panel.classList.toggle(
        "hidden"
      );
    }
  );

  panel.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();

      if (
        e.target.classList.contains(
          "emoji-opt"
        )
      ) {
        $("#composer-input").value +=
          e.target.textContent;

        panel.classList.add(
          "hidden"
        );

        $("#composer-input")?.focus();
      }
    }
  );

  document.addEventListener(
    "click",
    (e) => {
      if (
        !panel.classList.contains(
          "hidden"
        ) &&
        !panel.contains(e.target) &&
        e.target !== btn
      ) {
        panel.classList.add(
          "hidden"
        );
      }
    }
  );
}

// ===============================================================
// PWA INSTALL
// ===============================================================

function setupPWAInstallPrompt() {
  window.addEventListener(
    "beforeinstallprompt",
    (event) => {
      event.preventDefault();

      state.deferredInstallPrompt =
        event;

      refreshPWAInstallButton();
    }
  );

  window.addEventListener(
    "appinstalled",
    () => {
      state.deferredInstallPrompt =
        null;

      hidePWAInstallButton();
    }
  );

  window.addEventListener(
    "DOMContentLoaded",
    () => {
      refreshPWAInstallButton();
    }
  );
}

function getOrCreatePWAInstallButton() {
  let button =
    document.querySelector(
      "#install-app-btn"
    );

  if (!button) {
    button =
      document.querySelector(
        "#pwa-install-btn"
      );
  }

  if (!button) {
    const authScreen =
      $("#auth-screen");

    if (!authScreen) return null;

    const wrapper =
      document.createElement(
        "div"
      );

    wrapper.className =
      "pwa-install-wrapper";

    wrapper.innerHTML = `
      <button
        type="button"
        id="install-app-btn"
        class="pwa-install-btn hidden"
      >
        📲 تثبيت التطبيق
      </button>
    `;

    authScreen.appendChild(
      wrapper
    );

    button =
      wrapper.querySelector(
        "#install-app-btn"
      );
  }

  if (
    button &&
    !button.dataset.wired
  ) {
    button.dataset.wired =
      "1";

    button.addEventListener(
      "click",
      installPWA
    );
  }

  state.installButton =
    button;

  return button;
}

function refreshPWAInstallButton() {
  const button =
    getOrCreatePWAInstallButton();

  if (!button) return;

  const installed =
    isPWAInstalled();

  const canInstall =
    !!state.deferredInstallPrompt;

  const authVisible =
    !$("#auth-screen")?.classList.contains(
      "hidden"
    );

  if (
    canInstall &&
    !installed &&
    authVisible
  ) {
    button.classList.remove(
      "hidden"
    );

    button.disabled = false;

    button.setAttribute(
      "aria-label",
      "تثبيت التطبيق"
    );
  } else {
    button.classList.add(
      "hidden"
    );
  }
}

function isPWAInstalled() {
  const standalone =
    window.matchMedia &&
    window.matchMedia(
      "(display-mode: standalone)"
    ).matches;

  const fullscreen =
    window.matchMedia &&
    window.matchMedia(
      "(display-mode: fullscreen)"
    ).matches;

  const minimalUi =
    window.matchMedia &&
    window.matchMedia(
      "(display-mode: minimal-ui)"
    ).matches;

  const iosStandalone =
    window.navigator.standalone ===
    true;

  return (
    standalone ||
    fullscreen ||
    minimalUi ||
    iosStandalone
  );
}

async function installPWA() {
  const prompt =
    state.deferredInstallPrompt;

  if (!prompt) return;

  const button =
    state.installButton ||
    getOrCreatePWAInstallButton();

  if (button) {
    button.disabled = true;

    button.textContent =
      "جاري فتح التثبيت...";
  }

  try {
    await prompt.prompt();

    const result =
      await prompt.userChoice;

    state.deferredInstallPrompt =
      null;

    if (
      result?.outcome ===
      "accepted"
    ) {
      hidePWAInstallButton();
    } else {
      hidePWAInstallButton();
    }
  } catch (error) {
    console.error(
      "PWA install failed:",
      error
    );

    state.deferredInstallPrompt =
      null;

    hidePWAInstallButton();
  }
}

function hidePWAInstallButton() {
  const button =
    state.installButton ||
    document.querySelector(
      "#install-app-btn, #pwa-install-btn"
    );

  if (!button) return;

  button.classList.add(
    "hidden"
  );
}

// ===============================================================
// SERVICE WORKER
// ===============================================================

if ("serviceWorker" in navigator) {
  window.addEventListener(
    "load",
    () => {
      navigator.serviceWorker
        .register("./sw.js")
        .catch(() => {});
    }
  );
}

// ===============================================================
// START
// ===============================================================

document.addEventListener(
  "DOMContentLoaded",
  boot
);
