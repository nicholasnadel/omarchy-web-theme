# Omarchy Web Theme

Make Chromium and Brave pages follow the active Omarchy theme.

Omarchy Web Theme is a Chromium extension with a small local helper. It reads the
active Omarchy `colors.toml`, maps ordinary page colors into that palette, and
updates open tabs when the desktop theme changes. Images, video, canvas, SVG, and
CSS background images keep their original colors.

The original opt-in CSS variables and JavaScript API remain available for sites
that want exact control. Automatic theming is the fallback for everything else.

## Install

You need an Omarchy desktop and Chromium or Brave. There is no build step and no npm
install. The installer runs as your normal user, without `sudo`.

1. Open Chromium or Brave at least once so its profile exists.
2. Clone the project and run the installer:

```bash
git clone https://github.com/nicholasnadel/omarchy-web-theme.git
cd omarchy-web-theme
./install.sh
```

3. Fully quit and restart the browser.
4. Open `chrome://extensions` or `brave://extensions` and check for
   **Omarchy Web Theme**.

Keep the project folder in place. The browser loads the extension and its local
helper directly from this folder.

The runtime needs Bash, jq, inotify-tools, util-linux, and GNU coreutils with
`mv --no-copy` support. These tools are normally available on Omarchy. Python 3
is only needed for the demo. Node.js 22 or newer is only needed for tests.

Automatic setup uses the Omarchy Chromium and Brave launchers and their flags
files. The installer registers the native helper for other installed
Chromium-based browsers too, but you may need to load `extension/` manually in
those browsers. Firefox is not supported yet.

## Controls

Select the extension icon in the browser toolbar to:

- turn automatic page theming on or off globally;
- disable or re-enable it for the current hostname;
- confirm which Omarchy palette is connected.

The global switch and hostname exceptions are stored locally in the browser.
They sync neither to websites nor to a cloud account.

Automatic theming covers common backgrounds, text, links, borders, form
controls, selection, focus rings, and scrollbars. Sites with unusual rendering
can be excluded from the popup. Browser-owned pages such as `chrome://settings`
cannot be changed by extensions.

## Use Colors in CSS

The extension adds CSS variables to the page's `<html>` element:

```css
.card {
  background: var(--omarchy-background, #101913);
  color: var(--omarchy-foreground, #a1af9c);
  border: 1px solid var(--omarchy-accent, #4a9a68);
}
```

Always include a fallback color. Your site should still work when the extension
is not installed.

Color names come from the theme's `colors.toml` file. Underscores become hyphens:
`bright_green` becomes `--omarchy-bright-green`.

The `<html>` element also gets `data-omarchy-theme` and `data-omarchy-mode`
attributes for the theme name and light or dark mode.

## Use the JavaScript API

Check for `window.omarchy` before using it:

```js
const api = window.omarchy;

if (api) {
  console.log(api.theme);           // Theme name
  console.log(api.mode);            // "light" or "dark"
  console.log(api.color('accent')); // One color
  console.log(api.colors());        // All colors

  const stop = api.onChange((colors) => {
    console.log('Theme colors updated:', colors);
  });

  // Call stop() when your component or view is removed.
}
```

The palette arrives asynchronously. Initial reads can be empty; `onChange`
also fires when the first palette arrives.

## Try the Demo

From the project folder, run:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory demo
```

Open [http://localhost:8080](http://localhost:8080). In another terminal, switch
to a theme you have installed:

```bash
omarchy-theme-set "Tokyo Night"
```

The demo updates its colors without reloading. The server only listens on your
machine and only serves the `demo/` folder.

Localhost is **read-only by default**. To test the demo's theme buttons, uncomment
the exact `http://localhost:8080` entry in `THEME_WRITE_ORIGINS` in
[`extension/background.js`](extension/background.js), then reload the extension
at `chrome://extensions`. Reload the demo page too, so it reconnects. Disable this
entry when you finish development.

Do not allow every localhost port. Any app or HTML preview served from an allowed
origin gets the same permission to change your desktop theme.

## Apply or Install Themes

Reading colors is available to every page where the extension runs. Changing the
desktop theme is only allowed from a top-level `https://omarchy.org` page by
default. Embedded frames cannot write.

On an allowed page, check permission before showing theme controls. Run examples
with `await` in the browser console or a JavaScript module:

```js
const api = window.omarchy;

if (api && (await api.canSetTheme()).allowed) {
  const result = await api.setTheme('Tokyo Night');
  if (!result.ok) console.error(result.error);
}
```

To install a new palette from an allowed page:

```js
const result = await window.omarchy.installTheme({
  name: 'My Web Theme',
  colors: {
    background: '#101913',
    foreground: '#a1af9c',
    accent: '#4a9a68',
  },
});

if (!result.ok) console.error(result.error);
```

- Colors must be six-digit hex strings such as `#4a9a68`.
- `background`, `foreground`, and `accent` are required.
- Existing themes are never overwritten. Use `setTheme(name)` to apply them.
- An optional `backgroundUrl` must be a direct HTTPS image on an allowed wallpaper host. The bundled gallery has working examples.
- `{ ok: true }` means the request was accepted, not that the desktop has finished updating. Listen for `onChange` to see the result.

New themes are stored in `~/.config/omarchy/themes/<slug>/`. Gallery cards switch
to **Apply existing** after installation or an existing-name error.

## Security and Privacy

Every page where the extension runs can read your theme name and palette. Custom
colors can help identify you across sites. Disabling automatic styling for a
hostname does not currently remove the opt-in CSS/JavaScript palette API.

An allowed write origin can change your theme without a confirmation prompt.
Only add origins you trust.

The extension limits downloads to a trusted wallpaper host, rejects redirects,
and caps image size and download time. The local helper validates requests,
protects existing themes, and limits installation rate and storage use.

See [Security Notes](docs/security.md) for the exact permissions, limits, and
remaining trust assumptions.

## Development

The project uses plain JavaScript and Bash. No bundler or package installation
is required.

| Path | Purpose |
| --- | --- |
| `extension/` | Chromium extension, page theme engine, popup, and page API |
| `bin/omarchy-browser-theme-host` | Local helper that reads and applies themes |
| `demo/` | Live demo and example palettes |
| `install.sh` | Browser registration and removal |
| `tests/` | Security and behavior regression tests |

Run the tests from the project folder:

```bash
node --test tests/*.test.mjs
```

Tests use temporary profiles and stub desktop commands. They do not change your
real theme or browser profile. The browser DOM test uses headless Chromium and
skips if Chromium is unavailable. The other tests still run.

After changing extension code, reload it at `chrome://extensions`. Reloading also
restarts the connection to the local helper. Reload any open test pages afterward.

## Troubleshooting

- **The installer reports zero browser profiles:** Open Chromium once, then run `./install.sh` again.
- **The extension is missing:** Fully quit and restart Chromium or Brave, then
  check its extensions page.
- **A site looks wrong:** Use the extension popup to turn off **Theme this site**.
- **The palette is empty:** Confirm Omarchy has an active theme, then reload the extension.
- **Local demo buttons are disabled:** This is the default. Follow the exact-origin opt-in in [Try the Demo](#try-the-demo).
- **You want to move the project folder:** Uninstall from the old location first. Move it, then run the installer from the new location.

## Uninstall

Run this before deleting or moving the project folder:

```bash
./install.sh --uninstall
```

Restart the browser. This removes the browser registration, not themes you
previously installed or the helper's rate-limit state.

## License

[MIT](LICENSE). Externally hosted wallpapers are not covered by this license;
check the rights for those images before reusing them.

Omarchy Web Theme builds on
[Omarchy Theme Sync](https://github.com/omacom/omarchy-theme-sync) by Bjarne
Oeverli. Its original MIT copyright notice is preserved in this repository.

The extension icon uses the square logo from the
[official Omarchy brand assets](https://omarchy.org/brand). The logo is not covered
by this project's MIT license.
