const globalToggle = document.querySelector('#global');
const siteToggle = document.querySelector('#site');
const siteRow = document.querySelector('#siteRow');
const hostLabel = document.querySelector('#host');
const themeLabel = document.querySelector('#theme');

let currentHost = null;
let disabledHosts = [];

function setPalette(palette) {
  const colors = palette?.colors || {};
  const root = document.documentElement.style;
  root.colorScheme = palette?.mode === 'light' ? 'light' : 'dark';
  root.setProperty('--bg', colors.background || '#1b1b1b');
  root.setProperty('--panel', colors.lighter_background || colors.dark_background || '#252525');
  root.setProperty('--fg', colors.foreground || '#dddddd');
  root.setProperty('--muted', colors.light_foreground || colors.muted || '#919191');
  root.setProperty('--accent', colors.accent || '#7aa2f7');
  themeLabel.textContent = palette?.name ? `${palette.name} · ${palette.mode || 'dark'}` : 'Waiting for the Omarchy palette';
}

function paintSiteToggle() {
  const usable = Boolean(currentHost) && globalToggle.checked;
  siteToggle.disabled = !usable;
  siteToggle.checked = Boolean(currentHost) && !disabledHosts.includes(currentHost);
  siteRow.classList.toggle('disabled', !usable);
}

async function initialize() {
  const [stored, tabs] = await Promise.all([
    chrome.storage.local.get({ pageThemeEnabled: true, disabledHosts: [], palette: null }),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  setPalette(stored.palette);
  disabledHosts = Array.isArray(stored.disabledHosts) ? stored.disabledHosts : [];
  globalToggle.checked = stored.pageThemeEnabled !== false;
  try {
    const url = new URL(tabs[0]?.url || '');
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:') {
      currentHost = url.hostname || url.protocol;
    }
  } catch (_) {}
  hostLabel.textContent = currentHost || 'Unavailable on this browser page';
  paintSiteToggle();
}

globalToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ pageThemeEnabled: globalToggle.checked });
  paintSiteToggle();
});

siteToggle.addEventListener('change', async () => {
  if (!currentHost) return;
  const next = new Set(disabledHosts);
  if (siteToggle.checked) next.delete(currentHost);
  else next.add(currentHost);
  disabledHosts = [...next].sort();
  await chrome.storage.local.set({ disabledHosts });
});

initialize().catch(() => {
  themeLabel.textContent = 'Extension storage is unavailable';
  globalToggle.disabled = true;
  siteToggle.disabled = true;
});
