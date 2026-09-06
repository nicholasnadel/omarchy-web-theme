// Owns the single native messaging port and fans the palette out to every tab.
//
// The host pushes unprompted whenever omarchy-theme-set swaps the theme, so this
// worker mostly sits on an open port. Chrome keeps a service worker alive while a
// native port is connected, which is what lets a push arrive at all -- an idle
// MV3 worker would otherwise be torn down after 30s and miss it.

const HOST_NAME = 'com.omarchy.theme';
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 60000;
const REQUEST_TIMEOUT_MS = 15000;
const INSTALL_TIMEOUT_MS = 60000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_THEME_NAME_CHARS = 64;
const MAX_COLORS = 128;

// The wallpaper CDNs do not send CORS headers, so the page cannot read the bytes
// itself. Do not turn that exception into an arbitrary cross-origin proxy: an IP
// blacklist cannot account for DNS resolution or every IPv6 representation.
// Keep this list in sync with host_permissions in manifest.json.
const WALLPAPER_HOSTS = new Set(['wallpapers.hel1.your-objectstorage.com']);

// Reading the palette is open to every page. Changing the system theme is not:
// only the origins listed here, and only their top-level document, get the write
// path (setTheme, installTheme, and the wallpaper fetch it triggers).
//
// This check has to live in the worker, because only the worker sees an origin
// the page cannot forge: sender.origin is filled in by the browser. The native
// host is the wrong place for it -- it only ever learns the extension id, never
// which page asked.
const THEME_WRITE_ORIGINS = [
  // Production: the Omarchy site. https only, exact host -- no subdomains, so
  // neither themes.omarchy.org nor an attacker's omarchy.org.evil.com matches.
  /^https:\/\/omarchy\.org$/,
  // Local development is read-only unless explicitly opted in to an exact origin.
  // /^http:\/\/localhost:8080$/,
];

let port = null;
let pending = new Map();
let nextRequestId = 0;
let retryMs = RETRY_MIN_MS;
let retryTimer = null;
let installing = false;

function cache(palette) {
  // storage.local, not session: a content script at document_start needs the
  // palette even on the very first page load after the worker was torn down,
  // and session storage would be empty on a cold browser start.
  chrome.storage.local.set({ palette }).catch(() => {});
}

function broadcast(palette) {
  chrome.tabs.query({}, (tabs) => {
    void chrome.runtime.lastError;
    for (const tab of tabs || []) {
      if (tab.id === undefined) continue;
      // Tabs without our content script (chrome://, the web store) reject the
      // message; that is expected, so swallow the error rather than logging per tab.
      chrome.tabs.sendMessage(tab.id, { type: 'palette', palette }, () => {
        void chrome.runtime.lastError;
      });
    }
  });
}

function scheduleReconnect() {
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryMs);
  // Back off so a missing or crash-looping host does not spawn a process per second.
  retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
}

function connect() {
  if (port) return;

  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    port = null;
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener((message) => {
    if (!message) return;

    if (message.type === 'theme-result') {
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle({ ok: !!message.ok, name: message.name, error: message.error || '' });
      }
      return;
    }

    if (message.type !== 'palette') return;
    // A message proves the host is healthy, so the next disconnect starts its
    // backoff from scratch instead of inheriting a long delay.
    retryMs = RETRY_MIN_MS;
    cache(message);
    broadcast(message);
  });

  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    // A dropped port will never answer these, and a caller left awaiting a
    // promise that cannot settle is worse than a clear failure.
    for (const [id, settle] of pending) settle({ ok: false, error: 'host disconnected' });
    pending.clear();
    scheduleReconnect();
  });
}

// A content script asking for the palette is also the signal that the worker was
// respawned, so use it to re-open the port that died with the previous instance.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'omarchy-get-palette') return false;

  connect();
  chrome.storage.local.get('palette').then(
    (stored) => sendResponse(stored.palette || null),
    () => sendResponse(null)
  );

  return true; // keep the channel open for the async storage read
});

function base64(bytes) {
  let binary = '';
  // btoa takes a string, and spreading a multi-megabyte array into one call
  // overflows the argument list, so build it in chunks.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchImage(url) {
  let target;
  try {
    target = new URL(url);
  } catch (error) {
    throw new Error('background url is not a url');
  }
  if (target.protocol !== 'https:') throw new Error('background url must be https');
  if (!WALLPAPER_HOSTS.has(target.hostname) || target.port || target.username || target.password) {
    throw new Error('background url must use an allowed wallpaper host on the default HTTPS port');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let reader;
  try {
    // Refuse all redirects, including ones to another path on the same host.
    const response = await fetch(target.href, {
      redirect: 'error', credentials: 'omit', signal: controller.signal,
    });
    if (!response.ok) throw new Error('background fetch failed: HTTP ' + response.status);

    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'image/jpeg' && type !== 'image/png') throw new Error('background is not a JPEG or PNG');
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
      throw new Error('background is larger than 8MB');
    }
    if (!response.body) throw new Error('background is empty');

    reader = response.body.getReader();
    const buffer = new Uint8Array(MAX_IMAGE_BYTES);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_IMAGE_BYTES) throw new Error('background is larger than 8MB');
      buffer.set(value, size);
      size += value.byteLength;
    }
    if (!size) throw new Error('background is empty');
    return base64(buffer.subarray(0, size));
  } catch (error) {
    if (controller.signal.aborted) throw new Error('background download timed out');
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

function originOf(sender) {
  if (sender.origin) return sender.origin;
  try {
    return sender.url ? new URL(sender.url).origin : null;
  } catch (error) {
    return null;
  }
}

function maySetThemes(sender) {
  const origin = originOf(sender);
  // Only the top-level document of an allowlisted origin may write. A subframe --
  // an ad slot, or an allowlisted page that some other site has framed -- carries
  // the same origin but a non-zero frameId, so gating on frame 0 keeps the write
  // path off every embedded instance. frameId is set by the browser, not the page.
  const topFrame = sender.frameId === 0;
  const originAllowed = THEME_WRITE_ORIGINS.some((pattern) => pattern.test(origin || ''));
  return { origin, allowed: topFrame && originAllowed };
}

// Lets a page find out whether it is allowed to write before it renders a theme
// picker, instead of discovering it from a failed click.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'omarchy-can-set-theme') return false;
  sendResponse(maySetThemes(sender));
  return false;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'omarchy-set-theme') return false;

  const { origin, allowed } = maySetThemes(sender);
  if (!allowed) {
    sendResponse({ ok: false, error: 'origin not permitted to set themes: ' + origin });
    return false;
  }

  connect();
  if (!port) {
    sendResponse({ ok: false, error: 'native host unavailable' });
    return false;
  }

  const id = String(++nextRequestId);
  pending.set(id, sendResponse);
  const timer = setTimeout(() => {
    const settle = pending.get(id);
    if (!settle) return;
    pending.delete(id);
    settle({ ok: false, error: 'timed out waiting for host' });
  }, REQUEST_TIMEOUT_MS);

  // postMessage throws on a port that disconnected since the null check above --
  // a narrow race, but an uncaught throw here escapes before `return true`, so
  // Chrome sees no listener claiming the channel and closes it. The caller then
  // gets "The message port closed before a response was received", which says
  // nothing about what actually went wrong. Answer properly instead.
  try {
    port.postMessage({ type: 'set-theme', name: String(message.name || ''), id });
  } catch (error) {
    clearTimeout(timer);
    pending.delete(id);
    port = null;
    scheduleReconnect();
    sendResponse({ ok: false, error: 'native host connection lost, try again' });
    return false;
  }

  return true; // the host answers asynchronously
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'omarchy-install-theme') return false;

  const { origin, allowed } = maySetThemes(sender);
  if (!allowed) {
    sendResponse({ ok: false, error: 'origin not permitted to install themes: ' + origin });
    return false;
  }

  // Reject oversized or malformed palettes before fetching or native transport.
  const { name, colors, backgroundUrl = '' } = message;
  if (typeof name !== 'string' || !name.length || name.length > MAX_THEME_NAME_CHARS || /[\x00-\x1f\x7f]/.test(name) ||
      !colors || typeof colors !== 'object' || Array.isArray(colors) || Object.keys(colors).length > MAX_COLORS ||
      !['background', 'foreground', 'accent'].every((key) => Object.hasOwn(colors, key)) ||
      !Object.entries(colors).every(([key, value]) =>
        key.length <= 32 && /^[a-z]/.test(key) && !/[^a-z0-9_]/.test(key) &&
        typeof value === 'string' && value.length === 7 && /^#[0-9a-fA-F]{6}$/.test(value)) ||
      typeof backgroundUrl !== 'string' || backgroundUrl.length > 4096) {
    sendResponse({ ok: false, error: 'invalid theme specification' });
    return false;
  }
  if (installing) {
    sendResponse({ ok: false, error: 'another theme installation is in progress' });
    return false;
  }
  installing = true;
  let responded = false;
  const respond = (result) => {
    if (responded) return;
    responded = true;
    sendResponse(result);
  };

  (async () => {
    try {
      const background = backgroundUrl ? await fetchImage(backgroundUrl) : '';
      connect();
      if (!port) throw new Error('native host unavailable');

      const result = await new Promise((resolve) => {
        const id = String(++nextRequestId);
        const timer = setTimeout(() => {
          // Timing out the caller does not cancel native work. Keep admission
          // occupied until the host actually answers or disconnects.
          respond({ ok: false, error: 'timed out waiting for host' });
        }, INSTALL_TIMEOUT_MS);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          resolve(reply);
        });
        try {
          port.postMessage({ type: 'install-theme', id, name, colors, background });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          port = null;
          scheduleReconnect();
          resolve({ ok: false, error: 'native host connection lost, try again' });
        }
      });
      respond(result);
    } catch (error) {
      respond({ ok: false, error: String(error.message || error) });
    } finally {
      installing = false;
    }
  })();

  return true; // the fetch and the host both answer asynchronously
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
