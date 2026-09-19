# Security Notes

Omarchy Web Theme connects web pages to a local process. This document explains
what each side can do and which limits are enforced.

## Reading and Writing

The extension shares the current palette with every page where its content
scripts run, including embedded frames. This includes the theme name and color
values. Custom themes can be a fingerprinting signal. Reads have no per-site
permission prompt.

Writes are different. The service worker checks the browser-provided sender
origin and requires the top-level frame. By default, only `https://omarchy.org`
can set or install themes. Localhost and local files are read-only.

An allowed origin does not need a confirmation click to make a request. Its
scripts, including compromised or third-party scripts, have the same write
permission. Only allow origins you trust. A local development port does not
authenticate the app using that port.

The native helper only sees the extension ID, not the page origin. It separately
checks names, schemas, sizes, quotas, and rate limits before invoking Omarchy.
Palette values are rendered as text in the demo, not interpreted as HTML.

## Browser Permissions

| Permission or entry | Reason |
| --- | --- |
| `nativeMessaging` | Talk to the local Omarchy helper |
| `storage` | Cache the palette for the next page load |
| Content scripts on `<all_urls>` | Expose the CSS variables and page API |
| `https://wallpapers.hel1.your-objectstorage.com/*` | Download wallpapers whose server does not provide CORS headers |

The manifest's public key keeps the extension ID stable:
`ppnnomfimbfcofidkfmghapellfbgklc`. The helper registration allows only that
extension origin and uses the name `com.omarchy.theme`.

These are installed identities, not display names. Renaming the project does
not require changing them. Users do not need a private signing key to install
the unpacked extension. Private keys must not be committed or served over HTTP;
signing-key files are excluded by `.gitignore`.

## Safe Installation

Web-installed themes can contain a generated `colors.toml`, an optional image,
and a fixed quota marker. A page cannot supply arbitrary filenames or executable
configuration. Omarchy generates the other configuration files from its own
templates.

Names are limited to 64 characters before normalization. The normalized name
must match `[a-z0-9_][a-z0-9._+-]*`. Color keys must match
`[a-z][a-z0-9_]{0,31}` and values must be exactly six-digit hex colors.
Invalid entries are rejected rather than silently removed.

Existing user themes, built-in names, and symlinks are never replaced. A new
theme is staged on the destination filesystem, then published with an atomic
rename that refuses an existing destination. GNU `mv --no-copy` prevents a
non-atomic copy fallback. Failed installation does not delete existing themes.

Images are checked for JPEG or PNG magic bytes. This is not full image decoding
or a guarantee that an image is well-formed.

## Download Rules

The worker accepts only direct HTTPS image URLs on
`wallpapers.hel1.your-objectstorage.com`, using the default port and no URL
credentials. It omits request credentials and rejects all redirects.

This is an exact-host allowlist, not a private-IP blacklist. Arbitrary hostnames
and IPv4 or IPv6 literals are not accepted. Adding a host means trusting that
service's DNS and HTTPS endpoint.

To add another wallpaper service, update `WALLPAPER_HOSTS` in
`extension/background.js` and `host_permissions` in `extension/manifest.json`.
Do not add wildcard hosts or services with attacker-controlled DNS.

## Resource Limits

| Resource | Limit |
| --- | --- |
| Theme name | 64 characters before normalization |
| Installed palette | 128 entries; keys up to 32 characters |
| Readback palette file | 64 KiB; larger files produce an empty palette |
| Wallpaper | 8 MiB, checked during download and by the native helper |
| Download deadline | 30 seconds for headers and body together |
| Concurrent installations | One per worker, including download and native work |
| Installation native response deadline | 60 seconds for the caller |
| Theme-setting native response deadline | 15 seconds for the caller |
| Installation admission | At least 2 seconds apart, across helper connections |
| Browser-created themes | 64 directories and 256 MiB aggregate apparent size |
| Native request | 12 MiB, with exact framing and schema validation |
| Native response | 1 MiB |
| Theme application | At least 2 seconds apart per native connection |

If the caller times out, the worker does not queue another install behind the
unfinished native request. It waits for a native reply or disconnection before
accepting another installation. Reload the extension if the helper is stuck.

## Local Files and Locks

The helper reads the active palette from
`~/.local/state/omarchy/current/theme/colors.toml` and installs new themes under
`~/.config/omarchy/themes/`.

A private lock directory at `~/.local/state/omarchy/browser-theme-host/`
coordinates installation admission and quotas across browser instances. Admission
is persisted before theme writes, so reconnecting does not reset the interval.
An admitted attempt consumes the interval even if installation later fails.

New browser-created themes have a `.omarchy-browser-theme` marker containing
`1` and a newline. Quotas count these directories, including directory overhead.
Unrelated and legacy unmarked themes are not charged. Removing a counted theme
frees its quota.

Interrupted `.omarchy-browser-stage.*` directories remain charged if a process
is killed before cleanup. Staging can temporarily use another 8 MiB for an image,
plus its palette and directory overhead, before the final quota check. Ordinary
failures clean up their staging directory.

The markers are bookkeeping, not a boundary against another process running as
the same Unix user. The local user's filesystem, Omarchy installation, templates,
and commands are trusted.

Browser registration honors `XDG_CONFIG_HOME`. The helper's theme and state
paths above are under `HOME`. For nonstandard Omarchy installations,
`OMARCHY_PATH` must be available in the environment of the browser-launched helper.

## Testing Scope

Regression tests cover origins, download limits, DOM rendering, native framing,
installation collisions, quotas, locks, and preservation of browser flags.
They use temporary profiles and stub desktop commands.

Worker network requests and native ports are mocked. The Chromium test exercises
the DOM helpers, not a complete installed-extension workflow. These tests do not
replace a live integration test or a security audit of Omarchy and its image
decoders.
