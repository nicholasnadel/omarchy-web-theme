import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const project = fileURLToPath(new URL('../', import.meta.url));
const demo = readFileSync(join(project, 'demo/index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(project, 'extension/manifest.json'), 'utf8'));
const payload = "<img src=data:,not-an-image onerror='document.documentElement.dataset.reviewXss=1'>";
const maliciousKey = 'z_bad), red); color:red;" >' + payload;

function extract(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing helper boundary: ${start}`);
  return source.slice(from, to);
}

const swatches = extract(demo, '  const KNOWN =', '  function setStatus(');
const gallery = extract(demo, '  function setGalleryStatus(', '\n  buildGallery();');

test('automatic page styling loads after the startup-critical palette bridge', () => {
  const contentScript = manifest.content_scripts.find((entry) => entry.js.includes('content.js'));
  const pageTheme = manifest.content_scripts.find((entry) => entry.js.includes('page-theme.js'));
  assert.deepEqual(contentScript.js, ['content.js']);
  assert.equal(contentScript.run_at, 'document_start');
  assert.deepEqual(pageTheme.js, ['theme-utils.js', 'page-theme.js']);
  assert.equal(pageTheme.run_at, 'document_idle');
});

function domFixture(themes = [], api = { canSetTheme: async () => ({ allowed: false }) }) {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.className = '';
      this.children = [];
      this.style = {};
      this.text = '';
      this.listeners = new Map();
    }
    set innerHTML(value) { assert.fail('Theme renderers must not parse HTML'); }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.text = ''; this.children = [...children]; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
  }
  const nodes = Object.fromEntries(['count', 'swatches', 'gallery', 'galleryStatus'].map((id) => [id, new Element('div')]));
  const escaped = [];
  const functions = runInNewContext(swatches + gallery + '\n({ paintSwatches, buildGallery, KNOWN })', {
    document: {
      createElement: (tag) => new Element(tag),
      getElementById: (id) => nodes[id],
      querySelectorAll: (selector) => {
        assert.equal(selector, '.card');
        return nodes.gallery.children;
      },
    },
    CSS: { escape: (name) => { escaped.push(name); return `escaped-${escaped.length - 1}`; } },
    fetch: async () => ({ json: async () => themes }),
    window: { omarchy: api },
    location: { protocol: 'http:', origin: 'http://localhost:8080' },
  });
  return { ...functions, nodes, escaped };
}

test('swatches use literal text, escaped CSS names, existing classes, ordering and fallbacks', () => {
  const fixture = domFixture();
  const colors = { zebra: payload, background: '', alpha: '#abcdef', accent: '#123456', [maliciousKey]: payload };
  fixture.paintSwatches(colors);
  const cards = fixture.nodes.swatches.children;
  const labels = cards.map((card) => card.children[1].children[0].textContent);
  assert.deepEqual(labels, ['accent', 'background', ...['zebra', 'alpha', maliciousKey].sort((a, b) => a.localeCompare(b))]);
  assert.equal(fixture.nodes.count.textContent, String(labels.length));
  assert.deepEqual(fixture.escaped, labels.map((key) => '--omarchy-' + key.replace(/_/g, '-')));
  for (const [index, card] of cards.entries()) {
    assert.equal(card.tagName, 'div');
    assert.equal(card.className, 'sw');
    assert.deepEqual(card.children.map((child) => [child.tagName, child.className]), [['div', 'chip'], ['div', 'meta']]);
    assert.equal(card.children[0].style.backgroundColor, `var(escaped-${index}, var(--bg-light))`);
    const spans = card.children[1].children;
    assert.deepEqual(spans.map((span) => [span.tagName, span.className]), [['span', 'k'], ['span', 'v']]);
    assert.equal(spans[1].textContent, colors[labels[index]] || 'unset');
    assert.ok(spans.every((span) => span.children.length === 0));
  }
  fixture.paintSwatches({});
  assert.deepEqual(fixture.nodes.swatches.children.map((card) => card.children[1].children[0].textContent), Array.from(fixture.KNOWN));
  assert.ok(fixture.nodes.swatches.children.every((card) => card.children[1].children[1].textContent === 'unset'));
  fixture.paintSwatches({ accent: '#123456' });
  assert.equal(fixture.nodes.swatches.children.length, 1);
});

test('gallery constructs the existing card structure without parsing metadata as HTML', async () => {
  const theme = { name: payload, tone: payload, color: 'blue', thumb: 'data:,bad"' + payload,
    colors: { blue: '#333333', accent: payload, background: '#111111', red: '' } };
  const fixture = domFixture([theme]);
  await fixture.buildGallery();
  const [card] = fixture.nodes.gallery.children;
  assert.equal(card.tagName, 'button');
  assert.equal(card.className, 'card');
  assert.equal(card.type, 'button');
  assert.equal(card.disabled, true);
  assert.deepEqual(card.children.map((child) => child.className), ['shot', 'info']);
  assert.equal(card.children[0].style.backgroundImage, `url(${JSON.stringify(theme.thumb)})`);
  const info = card.children[1].children;
  assert.deepEqual(info.map((child) => child.className), ['nm', 'tone', 'strip', 'apply']);
  assert.equal(info[0].textContent, payload);
  assert.equal(info[1].textContent, payload + ' / blue');
  assert.equal(info[3].textContent, 'Install and apply');
  assert.deepEqual(info[2].children.map((child) => [child.tagName, child.style.backgroundColor]),
    [['i', '#111111'], ['i', payload], ['i', '#333333']]);
  assert.match(fixture.nodes.galleryStatus.textContent, /Localhost writes are disabled by default/);
  await fixture.buildGallery();
  assert.equal(fixture.nodes.gallery.children.length, 1);
});

for (const existing of [false, true]) {
  test(`gallery can apply a ${existing ? 'previously installed' : 'newly installed'} theme without reinstalling it`, async () => {
    const calls = [];
    const theme = { name: 'Review', colors: { accent: '#123456' } };
    const fixture = domFixture([theme], {
      canSetTheme: async () => ({ allowed: true }),
      installTheme: async (spec) => {
        calls.push(['install', spec.name]);
        return existing ? { ok: false, name: 'review', error: 'theme already exists; use setTheme' } : { ok: true, name: 'review' };
      },
      setTheme: async (name) => { calls.push(['set', name]); return { ok: true, name: 'review' }; },
    });
    await fixture.buildGallery();
    const [card] = fixture.nodes.gallery.children;
    const label = card.children[1].children[3];
    await card.listeners.get('click')();
    assert.equal(label.textContent, 'Apply existing');
    assert.equal(card.disabled, false);
    await card.listeners.get('click')();
    await card.listeners.get('click')();
    assert.deepEqual(calls, [['install', 'Review'], ['set', 'Review'], ['set', 'Review']]);
    assert.match(fixture.nodes.galleryStatus.textContent, /Requested review/);
  });
}

test('an unrelated gallery installation failure does not enable an existing-theme action', async () => {
  let installs = 0;
  const fixture = domFixture([{ name: 'Review', colors: {} }], {
    canSetTheme: async () => ({ allowed: true }),
    installTheme: async () => { installs++; return { ok: false, error: 'background is not a JPEG or PNG' }; },
    setTheme: async () => assert.fail('failed installation must not trigger an apply'),
  });
  await fixture.buildGallery();
  const [card] = fixture.nodes.gallery.children;
  await card.listeners.get('click')();
  await card.listeners.get('click')();
  assert.equal(installs, 2);
  assert.equal(card.children[1].children[3].textContent, 'Install and apply');
});

test('all demo server instructions bind loopback and serve only demo from the project root', () => {
  const commands = Array.from(demo.matchAll(/python3 -m http\.server[^\n<'"]*/g), (match) => match[0]);
  assert.ok(commands.length > 0);
  for (const command of commands) assert.equal(command, 'python3 -m http.server 8080 --bind 127.0.0.1 --directory demo');
  assert.match(demo, /explicitly allow this exact origin/);
});

function temporaryEnvironment(t) {
  const root = mkdtempSync(join(tmpdir(), 'omarchy-demo-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { root, env: {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: root,
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(root, 'no-session-bus'),
  } };
}

const proxy = '--proxy-server=socks5://127.0.0.1:9050';
const existing = ['/existing/one', '/existing/two'];
for (const [name, initial, kept, paths] of [
  ['missing flags', () => null, '', []],
  ['unterminated final proxy flag', () => '# keep this comment\n' + proxy, '# keep this comment\n' + proxy + '\n', []],
  ['unterminated existing extension list', () => '--lang=en-US\n--load-extension=' + existing.join(','), '--lang=en-US\n', existing],
  ['unterminated flag after an extension list', () => '--load-extension=' + existing.join(',') + '\n' + proxy, proxy + '\n', existing],
  ['duplicate own extension entries', (extension) => '--load-extension=' + [existing[0], extension, extension, existing[1]].join(','), '', existing],
  ['only the own extension', (extension) => '--load-extension=' + extension, '', []],
]) {
  test(`installer preserves ${name} through repeated install/uninstall`, (t) => {
    const { root, env } = temporaryEnvironment(t);
    const extension = join(root, 'extension');
    mkdirSync(extension);
    writeFileSync(join(extension, 'manifest.json'), '{}');
    const host = join(root, 'host-must-not-run');
    writeFileSync(host, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    mkdirSync(env.XDG_CONFIG_HOME);
    const unrelated = join(env.XDG_CONFIG_HOME, 'unrelated.conf');
    writeFileSync(unrelated, 'unchanged');
    const flags = join(env.XDG_CONFIG_HOME, 'chromium-flags.conf');
    const before = initial(extension);
    if (before !== null) writeFileSync(flags, before);
    const run = (uninstall = false) => execFileSync('/bin/bash', [join(project, 'install.sh'), ...(uninstall ? ['--uninstall'] : [])], {
      cwd: root,
      env: { ...env, OMARCHY_THEME_HOST_BIN: host, OMARCHY_THEME_EXTENSION_DIR: extension },
      encoding: 'utf8',
      timeout: 10000,
    });
    const uninstalled = kept + (paths.length ? '--load-extension=' + paths.join(',') + '\n' : '');
    run(true);
    if (before === null) {
      assert.equal(existsSync(flags), false);
    } else {
      assert.equal(readFileSync(flags, 'utf8'), uninstalled);
      writeFileSync(flags, before);
    }
    for (let i = 0; i < 2; i++) {
      run();
      assert.equal(readFileSync(flags, 'utf8'), kept + '--load-extension=' + [...paths, extension].join(',') + '\n');
    }
    for (let i = 0; i < 2; i++) {
      run(true);
      assert.equal(readFileSync(flags, 'utf8'), uninstalled);
    }
    assert.equal(readFileSync(unrelated, 'utf8'), 'unchanged');
    assert.deepEqual(readdirSync(env.XDG_CONFIG_HOME).sort(), ['chromium-flags.conf', 'unrelated.conf']);
  });
}

test('installer loads the extension in Brave when a Brave profile exists', (t) => {
  const { root, env } = temporaryEnvironment(t);
  const extension = join(root, 'extension');
  mkdirSync(extension);
  writeFileSync(join(extension, 'manifest.json'), '{}');
  const host = join(root, 'host-must-not-run');
  writeFileSync(host, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  mkdirSync(join(env.XDG_CONFIG_HOME, 'BraveSoftware/Brave-Browser'), { recursive: true });

  const run = (uninstall = false) => execFileSync('/bin/bash', [join(project, 'install.sh'), ...(uninstall ? ['--uninstall'] : [])], {
    cwd: root,
    env: { ...env, OMARCHY_THEME_HOST_BIN: host, OMARCHY_THEME_EXTENSION_DIR: extension },
    encoding: 'utf8',
    timeout: 10000,
  });

  run();
  assert.equal(readFileSync(join(env.XDG_CONFIG_HOME, 'brave-flags.conf'), 'utf8'), `--load-extension=${extension}\n`);
  assert.equal(readFileSync(join(env.XDG_CONFIG_HOME, 'chromium-flags.conf'), 'utf8'), `--load-extension=${extension}\n`);
  assert.equal(existsSync(join(env.XDG_CONFIG_HOME, 'BraveSoftware/Brave-Browser/NativeMessagingHosts/com.omarchy.theme.json')), true);

  run(true);
  assert.equal(readFileSync(join(env.XDG_CONFIG_HOME, 'brave-flags.conf'), 'utf8'), '');
  assert.equal(existsSync(join(env.XDG_CONFIG_HOME, 'BraveSoftware/Brave-Browser/NativeMessagingHosts/com.omarchy.theme.json')), false);
});

const chromium = ['chromium', 'chromium-browser', 'google-chrome'].flatMap((name) =>
  (process.env.PATH || '').split(delimiter).map((directory) => join(directory, name))).find((file) => {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
});

test('automatic theming yields to dense app hydration until page load', {
  skip: chromium ? false : 'Chromium is not installed',
  timeout: 60000,
}, (t) => {
  const { root, env } = temporaryEnvironment(t);
  const page = join(root, 'hydration.html');
  const utilsUrl = pathToFileURL(join(project, 'extension/theme-utils.js')).href;
  const themeUrl = pathToFileURL(join(project, 'extension/page-theme.js')).href;
  writeFileSync(page, `<!doctype html>
<html style="--omarchy-background:#111c18;--omarchy-dark-background:#0c1512;--omarchy-darker-background:#090f0d;--omarchy-lighter-background:#23372b;--omarchy-foreground:#c1c497;--omarchy-accent:#509475" data-omarchy-mode="dark">
<head><meta charset="utf-8"><style>html,body{background:#212121;color:#eee}</style>
<script>globalThis.chrome={storage:{local:{get:()=>Promise.resolve({pageThemeEnabled:true,disabledHosts:[]})},onChanged:{addListener(){}}}};</script>
<script>new MutationObserver(()=>{const rows=[...document.querySelectorAll('#app>div')];if(document.documentElement.hasAttribute('data-omarchy-page-theme'))document.documentElement.dataset.activation=rows.length===3000&&rows.every(node=>node.hasAttribute('data-omarchy-auto-fg'))?'atomic':'progressive'}).observe(document.documentElement,{attributes:true,attributeFilter:['data-omarchy-page-theme']});</script>
<script src="${utilsUrl}"></script><script src="${themeUrl}"></script></head>
<body><main id="app"></main><script>
const app=document.getElementById('app');
for(let i=0;i<3000;i++){const node=document.createElement('div');node.textContent='row '+i;app.appendChild(node)}
document.documentElement.dataset.hydration=document.documentElement.hasAttribute('data-omarchy-page-theme')?'themed-too-early':'completed-before-theme';
window.addEventListener('load',()=>setTimeout(()=>{document.documentElement.dataset.themeState=document.documentElement.getAttribute('data-omarchy-page-theme')||'missing'},500));
</script></body></html>`);
  const result = spawnSync(chromium, [
    '--headless', '--disable-extensions', '--disable-background-networking', '--disable-component-update',
    '--disable-default-apps', '--disable-sync', '--disable-breakpad', '--no-first-run',
    '--no-default-browser-check', '--no-proxy-server', '--allow-file-access-from-files', '--disable-gpu',
    '--dump-dom', '--virtual-time-budget=2000', '--user-data-dir=' + join(root, 'browser-profile'),
    pathToFileURL(page).href,
  ], { cwd: root, env, encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const htmlTag = result.stdout.match(/<html\b[^>]*>/)?.[0] || '';
  assert.match(htmlTag, /data-hydration="completed-before-theme"/);
  assert.match(htmlTag, /data-theme-state="dark"/);
  assert.match(htmlTag, /data-activation="atomic"/);
  assert.doesNotMatch(htmlTag, /data-omarchy-theme-activating=/);
});

test('Chromium keeps palette and gallery payloads inert through unchanged DOM helpers', {
  skip: chromium ? false : 'Chromium is not installed; dependency-free DOM safety tests still run',
  timeout: 60000,
}, (t) => {
  const { root, env } = temporaryEnvironment(t);
  const content = readFileSync(join(project, 'extension/content.js'), 'utf8');
  const api = readFileSync(join(project, 'extension/page-api.js'), 'utf8');
  const apply = extract(content, 'function apply(palette) {', '// Two sources,');
  const colors = extract(api, '  function colors() {', '  Object.defineProperty(');
  const data = JSON.stringify({ payload, maliciousKey }).replaceAll('<', '\\u003c');
  const page = join(root, 'xss.html');
  writeFileSync(page, `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'">
<style>:root { --bg-light: #28302b; }</style></head><body>
<div id="count"></div><div id="swatches"></div><div id="gallery"></div><div id="galleryStatus"></div>
<script>
const data = ${data};
const VAR_PREFIX = '--omarchy-';
const CHANGE_EVENT = 'omarchythemechange';
let applied = null;
${apply}
${colors}
${swatches}
${gallery}
function check(ok, message) { if (!ok) throw new Error(message); }
(async () => {
  apply({ colors: { background: '#101913', accent: '#123456', review: data.payload } });
  check(colors().review === data.payload, 'CSS/API round trip changed the payload');
  paintSwatches(colors());
  check(document.querySelector('#swatches .v').textContent === '#123456', 'Known ordering changed');
  const chip = document.querySelector('#swatches .chip');
  check(getComputedStyle(chip).backgroundColor === 'rgb(18, 52, 86)', 'Live color missing');
  document.documentElement.style.setProperty('--omarchy-accent', '#654321');
  check(getComputedStyle(chip).backgroundColor === 'rgb(101, 67, 33)', 'Live retint broken');
  check([...document.querySelectorAll('#swatches .v')].some((el) => el.textContent === data.payload), 'Payload not rendered literally');
  check(!document.querySelector('#swatches img'), 'Palette created an image');
  apply({ colors: {} });
  paintSwatches({});
  check(document.querySelectorAll('#swatches .sw').length === KNOWN.length, 'Fallback keys changed');
  check(getComputedStyle(document.querySelector('#swatches .chip')).backgroundColor === 'rgb(40, 48, 43)', 'Fallback color changed');
  paintSwatches({ [data.maliciousKey]: data.payload });
  check(document.querySelector('#swatches .k').textContent === data.maliciousKey, 'Key not rendered literally');
  check(document.querySelector('#swatches .chip').style.length === 1, 'Key escaped its CSS property');
  window.fetch = async () => ({ json: async () => [{
    name: data.payload, tone: data.payload, color: data.payload,
    thumb: 'data:,bad"' + data.payload, colors: { background: '#123456', accent: data.payload },
  }] });
  await buildGallery();
  check(document.querySelector('#gallery .nm').textContent === data.payload, 'Gallery name not literal');
  check(getComputedStyle(document.querySelector('#gallery .strip i')).backgroundColor === 'rgb(18, 52, 86)', 'Gallery color changed');
  check(!document.querySelector('#swatches img, #gallery img, #swatches [onerror], #gallery [onerror]'), 'Payload created active markup');
  // A separate positive control proves inline error handlers actually run here.
  const control = document.createElement('div');
  control.innerHTML = data.payload.replace('reviewXss', 'controlXss');
  document.body.appendChild(control);
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(document.documentElement.dataset.controlXss === '1', 'Positive control did not execute');
  check(!document.documentElement.dataset.reviewXss, 'Theme payload executed');
  document.documentElement.dataset.result = 'passed';
})().catch((error) => { document.documentElement.dataset.error = error.message; });
</script></body></html>`);
  const result = spawnSync(chromium, [
    '--headless', '--disable-extensions', '--disable-background-networking', '--disable-component-update',
    '--disable-default-apps', '--disable-sync', '--disable-breakpad', '--no-first-run',
    '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND',
    '--password-store=basic', '--disable-gpu', '--dump-dom', '--virtual-time-budget=2000',
    '--user-data-dir=' + join(root, 'browser-profile'), pathToFileURL(page).href,
  ], { cwd: root, env, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const htmlTag = result.stdout.match(/<html\b[^>]*>/)?.[0] || '';
  assert.match(htmlTag, /data-control-xss="1"/);
  assert.match(htmlTag, /data-result="passed"/);
  assert.doesNotMatch(htmlTag, /data-review-xss=/);
});
