// Pure color helpers for the automatic page theme. This file intentionally has
// no browser API dependencies so the transformation rules can be unit tested.

globalThis.OmarchyThemeUtils = (() => {
  const clamp = (value, min = 0, max = 255) => Math.min(max, Math.max(min, value));

  function parseColor(value) {
    if (typeof value !== 'string') return null;
    const input = value.trim();
    let match = input.match(/^#([0-9a-f]{6})$/i);
    if (match) {
      const number = Number.parseInt(match[1], 16);
      return { r: number >> 16, g: (number >> 8) & 255, b: number & 255, a: 1 };
    }
    match = input.match(/^#([0-9a-f]{3})$/i);
    if (match) {
      const [r, g, b] = [...match[1]].map((part) => Number.parseInt(part + part, 16));
      return { r, g, b, a: 1 };
    }
    match = input.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
    if (!match) return null;
    const alpha = match[4]?.endsWith('%') ? Number.parseFloat(match[4]) / 100 : Number.parseFloat(match[4] ?? '1');
    return {
      r: clamp(Number.parseFloat(match[1])),
      g: clamp(Number.parseFloat(match[2])),
      b: clamp(Number.parseFloat(match[3])),
      a: clamp(Number.isFinite(alpha) ? alpha : 1, 0, 1),
    };
  }

  function hex(color) {
    if (!color) return null;
    return '#' + [color.r, color.g, color.b]
      .map((value) => Math.round(clamp(value)).toString(16).padStart(2, '0'))
      .join('');
  }

  function mix(first, second, amount) {
    const a = parseColor(first);
    const b = parseColor(second);
    if (!a) return second;
    if (!b) return first;
    const weight = clamp(amount, 0, 1);
    return hex({
      r: a.r * (1 - weight) + b.r * weight,
      g: a.g * (1 - weight) + b.g * weight,
      b: a.b * (1 - weight) + b.b * weight,
    });
  }

  function luminance(color) {
    const parsed = typeof color === 'string' ? parseColor(color) : color;
    if (!parsed) return 0;
    const channel = (value) => {
      const normalized = value / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(parsed.r) + 0.7152 * channel(parsed.g) + 0.0722 * channel(parsed.b);
  }

  function chroma(color) {
    const parsed = typeof color === 'string' ? parseColor(color) : color;
    if (!parsed) return 0;
    return (Math.max(parsed.r, parsed.g, parsed.b) - Math.min(parsed.r, parsed.g, parsed.b)) / 255;
  }

  function hue(color) {
    const parsed = typeof color === 'string' ? parseColor(color) : color;
    if (!parsed) return 0;
    const r = parsed.r / 255;
    const g = parsed.g / 255;
    const b = parsed.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (!delta) return 0;
    let result;
    if (max === r) result = ((g - b) / delta) % 6;
    else if (max === g) result = (b - r) / delta + 2;
    else result = (r - g) / delta + 4;
    return (result * 60 + 360) % 360;
  }

  function normalizePalette(colors = {}, mode = 'dark') {
    const dark = mode !== 'light';
    const fallback = dark
      ? { background: '#1b1b1b', foreground: '#d7d7d7', accent: '#7aa2f7' }
      : { background: '#f4f1e8', foreground: '#242424', accent: '#315f9d' };
    const background = colors.background || fallback.background;
    const foreground = colors.foreground || fallback.foreground;
    return {
      mode: dark ? 'dark' : 'light',
      background,
      darker: colors.darker_background || mix(background, dark ? '#000000' : '#ffffff', 0.28),
      dark: colors.dark_background || mix(background, dark ? '#000000' : '#ffffff', 0.16),
      lighter: colors.lighter_background || mix(background, dark ? '#ffffff' : '#000000', 0.09),
      foreground,
      muted: colors.light_foreground || colors.muted || mix(foreground, background, 0.42),
      faint: colors.dark_foreground || colors.muted || mix(foreground, background, 0.62),
      accent: colors.accent || colors.blue || fallback.accent,
      selection: colors.selection || mix(colors.accent || fallback.accent, background, 0.5),
      named: {
        red: colors.red || colors.bright_red || '#c75d5d',
        orange: colors.orange || colors.yellow || '#c98a4a',
        yellow: colors.yellow || colors.bright_yellow || '#c9a554',
        green: colors.green || colors.bright_green || '#6e9c68',
        cyan: colors.cyan || colors.bright_cyan || '#68a2a0',
        blue: colors.blue || colors.bright_blue || colors.accent || fallback.accent,
        magenta: colors.magenta || colors.bright_magenta || '#a97ca8',
      },
    };
  }

  function namedColor(source, palette) {
    const angle = hue(source);
    if (angle < 18 || angle >= 345) return palette.named.red;
    if (angle < 45) return palette.named.orange;
    if (angle < 75) return palette.named.yellow;
    if (angle < 165) return palette.named.green;
    if (angle < 200) return palette.named.cyan;
    if (angle < 265) return palette.named.blue;
    return palette.named.magenta;
  }

  function transformBackground(source, palette) {
    const parsed = parseColor(source);
    if (!parsed || parsed.a < 0.04) return null;
    const light = luminance(parsed);
    const vivid = chroma(parsed) > 0.17;
    let target;
    if (palette.mode === 'dark') {
      if (light > 0.8) target = palette.background;
      else if (light > 0.35) target = palette.lighter;
      else if (light > 0.08) target = palette.dark;
      else target = palette.darker;
    } else {
      if (light < 0.08) target = palette.background;
      else if (light < 0.35) target = palette.lighter;
      else if (light < 0.8) target = palette.dark;
      else target = palette.darker;
    }
    return vivid ? mix(target, namedColor(parsed, palette), 0.18) : target;
  }

  function transformText(source, palette, role = '') {
    const parsed = parseColor(source);
    if (!parsed || parsed.a < 0.12) return null;
    if (role === 'link' || role === 'accent') return palette.accent;
    const normalized = hex(parsed);
    // The root stylesheet supplies this value to otherwise unstyled pages.
    // Keep the primary foreground stable while authored muted colors still go
    // through the contrast mapper.
    if (normalized === palette.foreground.toLowerCase()) return palette.foreground;
    if (chroma(parsed) > 0.18) return namedColor(parsed, palette);
    const light = luminance(parsed);
    if (light > 0.22 && light < 0.62) return palette.muted;
    return palette.foreground;
  }

  function transformBorder(source, palette) {
    const parsed = parseColor(source);
    if (!parsed || parsed.a < 0.08) return null;
    if (chroma(parsed) > 0.2) return mix(namedColor(parsed, palette), palette.background, 0.2);
    return mix(palette.muted, palette.background, 0.38);
  }

  return Object.freeze({
    parseColor, hex, mix, luminance, chroma, hue, normalizePalette,
    transformBackground, transformText, transformBorder,
  });
})();
