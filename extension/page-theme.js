// Automatic, palette-aware page theming. The engine maps authored colors into
// semantic Omarchy roles while leaving images, gradients, canvas and media alone.

(() => {
  const utils = globalThis.OmarchyThemeUtils;
  if (!utils) return;

  const ROOT_ATTRIBUTE = 'data-omarchy-page-theme';
  const AUTO_PROPERTIES = ['--omarchy-auto-bg', '--omarchy-auto-fg', '--omarchy-auto-border'];
  const SKIP_SELECTOR = [
    'img', 'picture', 'video', 'canvas', 'svg', 'iframe', 'object', 'embed',
    '[data-omarchy-ignore]', '[aria-hidden="true"] > svg',
  ].join(',');
  const host = location.hostname || location.protocol;
  let settings = { pageThemeEnabled: true, disabledHosts: [] };
  let palette = null;
  let sourceMode = 'light';
  let sourceBackgroundLuminance = null;
  let observer = null;
  let mutationFlushScheduled = false;
  const pendingRoots = new Set();
  let generation = 0;

  function readPalette() {
    const root = document.documentElement;
    if (!root) return null;
    const colors = {};
    for (let i = 0; i < root.style.length; i++) {
      const property = root.style[i];
      if (!property.startsWith('--omarchy-') || property.startsWith('--omarchy-auto-')) continue;
      colors[property.slice('--omarchy-'.length).replace(/-/g, '_')] = root.style.getPropertyValue(property).trim();
    }
    if (!colors.background || !colors.foreground || !colors.accent) return null;
    return utils.normalizePalette(colors, root.dataset.omarchyMode || 'dark');
  }

  function isEnabled() {
    return settings.pageThemeEnabled !== false && !settings.disabledHosts.includes(host);
  }

  function detectSourceAppearance() {
    const surfaces = [document.body, document.documentElement].filter(Boolean);
    for (const element of surfaces) {
      const color = utils.parseColor(getComputedStyle(element).backgroundColor);
      if (color && color.a >= 0.5) {
        const backgroundLuminance = utils.luminance(color);
        return {
          mode: backgroundLuminance < 0.18 ? 'dark' : 'light',
          backgroundLuminance,
        };
      }
    }
    // Transparent pages normally inherit the browser canvas. Their text still
    // reveals whether they were authored for a light or dark canvas.
    for (const element of surfaces) {
      const color = utils.parseColor(getComputedStyle(element).color);
      if (color && color.a >= 0.5) {
        return { mode: utils.luminance(color) > 0.55 ? 'dark' : 'light', backgroundLuminance: null };
      }
    }
    return { mode: 'light', backgroundLuminance: null };
  }

  function clearElement(element) {
    element.removeAttribute('data-omarchy-auto-bg');
    element.removeAttribute('data-omarchy-auto-fg');
    element.removeAttribute('data-omarchy-auto-border');
    for (const property of AUTO_PROPERTIES) element.style.removeProperty(property);
  }

  function stop() {
    generation++;
    observer?.disconnect();
    observer = null;
    mutationFlushScheduled = false;
    pendingRoots.clear();
    document.documentElement?.removeAttribute(ROOT_ATTRIBUTE);
    for (const element of document.querySelectorAll('[data-omarchy-auto-bg], [data-omarchy-auto-fg], [data-omarchy-auto-border]')) {
      clearElement(element);
    }
  }

  function themeElement(element) {
    if (!(element instanceof Element) || element.matches(SKIP_SELECTOR) || element.closest('[data-omarchy-ignore]')) return;
    const style = getComputedStyle(element);
    const backgroundImage = style.backgroundImage;
    const background = backgroundImage === 'none'
      ? utils.transformBackground(style.backgroundColor, palette, sourceMode, sourceBackgroundLuminance)
      : null;
    const role = element.matches('a, [role="link"]') ? 'link' : '';
    const parentForeground = element.parentElement?.style.getPropertyValue('--omarchy-auto-fg').trim();
    const sourceForeground = utils.hex(utils.parseColor(style.color));
    // Dynamic children often inherit an already transformed parent color. That
    // is a known generated value, so retain it. Explicit child colors still run
    // through the normal mapper even when they resemble a palette role.
    const foreground = !role && parentForeground && sourceForeground === parentForeground.toLowerCase()
      ? parentForeground
      : utils.transformText(style.color, palette, role);
    const borderSource = [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor]
      .find((color) => utils.parseColor(color)?.a > 0.08);
    const border = borderSource ? utils.transformBorder(borderSource, palette) : null;

    if (background) {
      element.style.setProperty('--omarchy-auto-bg', background);
      element.setAttribute('data-omarchy-auto-bg', '');
    } else {
      element.style.removeProperty('--omarchy-auto-bg');
      element.removeAttribute('data-omarchy-auto-bg');
    }
    if (foreground) {
      element.style.setProperty('--omarchy-auto-fg', foreground);
      element.setAttribute('data-omarchy-auto-fg', '');
    }
    if (border && style.borderStyle !== 'none') {
      element.style.setProperty('--omarchy-auto-border', border);
      element.setAttribute('data-omarchy-auto-border', '');
    } else {
      element.style.removeProperty('--omarchy-auto-border');
      element.removeAttribute('data-omarchy-auto-border');
    }
  }

  function collect(root) {
    if (!(root instanceof Element)) return [];
    // Descendants first prevents a transformed parent from changing the
    // computed inherited color before its existing children are inspected.
    return [root, ...root.querySelectorAll('*')].reverse();
  }

  function process(elements, run) {
    let index = 0;
    const slice = (deadline) => {
      if (run !== generation || !isEnabled()) return;
      const started = performance.now();
      while (index < elements.length) {
        themeElement(elements[index++]);
        const outOfIdleTime = deadline && deadline.timeRemaining() < 1;
        if (outOfIdleTime || (!deadline && performance.now() - started > 8)) break;
      }
      if (index < elements.length) schedule(slice);
    };
    // Do one bounded pass now so the initial viewport is themed before first
    // paint even on busy apps where idle callbacks are delayed indefinitely.
    slice(null);
  }

  function schedule(callback) {
    if ('requestIdleCallback' in globalThis) requestIdleCallback(callback, { timeout: 120 });
    else setTimeout(() => callback(null), 0);
  }

  function queueMutations(mutations, run) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) pendingRoots.add(node);
      }
    }
    if (!pendingRoots.size || mutationFlushScheduled) return;
    mutationFlushScheduled = true;
    schedule(() => {
      mutationFlushScheduled = false;
      if (run !== generation || !isEnabled()) {
        pendingRoots.clear();
        return;
      }
      const elements = [];
      const seen = new Set();
      for (const root of pendingRoots) {
        for (const element of collect(root)) {
          if (!seen.has(element)) {
            seen.add(element);
            elements.push(element);
          }
        }
      }
      pendingRoots.clear();
      process(elements, run);
    });
  }

  function start() {
    const nextPalette = readPalette();
    if (!nextPalette || !isEnabled() || !document.documentElement) {
      stop();
      return;
    }
    // Read authored styles on every pass. Leaving the previous generated
    // attributes active would feed our own transformed colors back into the
    // mapper when the desktop theme changes or the cached palette is replayed.
    observer?.disconnect();
    observer = null;
    mutationFlushScheduled = false;
    pendingRoots.clear();
    document.documentElement.removeAttribute(ROOT_ATTRIBUTE);
    for (const element of document.querySelectorAll('[data-omarchy-auto-bg], [data-omarchy-auto-fg], [data-omarchy-auto-border]')) {
      clearElement(element);
    }
    palette = nextPalette;
    const sourceAppearance = detectSourceAppearance();
    sourceMode = sourceAppearance.mode;
    sourceBackgroundLuminance = sourceAppearance.backgroundLuminance;
    generation++;
    const run = generation;
    document.documentElement.setAttribute(ROOT_ATTRIBUTE, palette.mode);
    process(collect(document.documentElement), run);

    observer = new MutationObserver((mutations) => queueMutations(mutations, run));
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function requestStart() {
    // Styling during framework hydration can monopolize the main thread or
    // make a single-page app observe our temporary overrides. Wait until the
    // page has loaded, then yield once more to the browser's idle queue.
    if (document.readyState !== 'complete') return;
    schedule(start);
  }

  function refreshSettings() {
    chrome.storage.local.get({ pageThemeEnabled: true, disabledHosts: [] }).then((stored) => {
      settings = {
        pageThemeEnabled: stored.pageThemeEnabled !== false,
        disabledHosts: Array.isArray(stored.disabledHosts) ? stored.disabledHosts.filter((item) => typeof item === 'string') : [],
      };
      requestStart();
    }).catch(stop);
  }

  document.addEventListener('omarchythemechange', requestStart);
  if (document.readyState !== 'complete') window.addEventListener('load', requestStart, { once: true });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.pageThemeEnabled || changes.disabledHosts)) refreshSettings();
  });

  refreshSettings();
})();
