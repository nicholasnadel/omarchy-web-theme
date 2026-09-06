import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const themes = JSON.parse(readFileSync(new URL('../demo/themes.json', import.meta.url), 'utf8'));
const wallpaperHost = 'wallpapers.hel1.your-objectstorage.com';
const wallpaper = `https://${wallpaperHost}/test.png`;
const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const colors = { background: '#112233', foreground: '#DDEEFF', accent: '#445566' };
const trusted = { origin: 'https://omarchy.org', frameId: 0 };
const flush = () => new Promise(setImmediate);

function event() {
  const listeners = [];
  return { addListener: (listener) => listeners.push(listener), emit: (...args) => listeners.map((listener) => listener(...args)) };
}

function worker(fetchImpl = async () => { throw new Error('unexpected fetch'); }) {
  const messages = event();
  const timers = new Map();
  const ports = [];
  const posts = [];
  const fetches = [];
  let timerId = 0;
  const context = vm.createContext({
    URL, Uint8Array, AbortController, btoa,
    fetch: (url, options) => {
      fetches.push({ url, options });
      return fetchImpl(url, options);
    },
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    chrome: {
      runtime: {
        onMessage: messages, onStartup: event(), onInstalled: event(),
        connectNative: () => {
          const port = { onMessage: event(), onDisconnect: event(), postMessage: (message) => posts.push(message) };
          ports.push(port);
          return port;
        },
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      tabs: { query: (_query, callback) => callback([]), sendMessage: () => {} },
    },
  });
  vm.runInContext(source + '\nglobalThis.testApi = { fetchImage, maySetThemes, DOWNLOAD_TIMEOUT_MS, INSTALL_TIMEOUT_MS, MAX_IMAGE_BYTES };', context);
  const send = (message, sender = trusted) => {
    const replies = [];
    const result = new Promise((resolve) => messages.emit(message, sender, (reply) => {
      replies.push(reply);
      resolve(reply);
    }));
    result.replies = replies;
    return result;
  };
  return {
    ...context.testApi, fetches, posts, ports, timers,
    send,
    install: (extra = {}, sender = trusted) => send({
      type: 'omarchy-install-theme', name: 'Review', colors, ...extra,
    }, sender),
    finish: (extra = {}) => ports.at(-1).onMessage.emit({ type: 'theme-result', id: posts.at(-1).id, ok: true, name: posts.at(-1).name, ...extra }),
    fire: (delay) => {
      const matching = [...timers.entries()].filter(([, timer]) => timer.delay === delay);
      assert.equal(matching.length, 1, `exactly one ${delay}ms timer`);
      const [id, timer] = matching[0];
      timers.delete(id);
      timer.callback();
    },
  };
}

test('only the exact production origin in the top frame may write by default', async () => {
  const w = worker();
  assert.equal(w.maySetThemes(trusted).allowed, true);
  const denied = [
    { ...trusted, frameId: 1 }, { origin: trusted.origin },
    { origin: 'null', url: trusted.origin, frameId: 0 },
    ...['http://localhost', 'http://localhost:8080', 'https://localhost:54321',
      'https://omarchy.org:444', 'http://omarchy.org', 'https://themes.omarchy.org',
      'https://omarchy.org.evil.example', 'https://evil.example', 'file://', 'null']
      .map((origin) => ({ origin, frameId: 0 })),
  ];
  for (const sender of denied) {
    assert.equal(w.maySetThemes(sender).allowed, false, JSON.stringify(sender));
    assert.equal((await w.install({ backgroundUrl: wallpaper }, sender)).ok, false);
    assert.equal((await w.send({ type: 'omarchy-set-theme', name: 'Review' }, sender)).ok, false);
  }
  assert.equal(w.fetches.length, 0);
  assert.equal(w.posts.length, 0);
});

test('wallpaper allowlist rejects private IPv4/IPv6, unknown hosts, alternate ports and credentials before fetching', async () => {
  const w = worker();
  for (const url of [
    'https://[::1]/', 'https://[::]/', 'https://[fc00::1]/', 'https://[fe80::1]/',
    'https://[::ffff:127.0.0.1]/', 'https://[::ffff:192.168.1.1]/',
    'https://[2001:4860:4860::8888]/', 'https://127.0.0.1/', 'https://127.1/',
    'https://2130706433/', 'https://192.168.1.1/', 'https://10.1.2.3/',
    'https://localhost/', 'https://internal/', 'https://evil.example/',
    `https://${wallpaperHost}.evil.example/`, `https://evil.${wallpaperHost}/`,
    `https://${wallpaperHost}./`, `https://${wallpaperHost}:8443/`,
    `https://user:pass@${wallpaperHost}/`, `https://${wallpaperHost}@127.0.0.1/`,
    `http://${wallpaperHost}/`, 'data:image/png;base64,AA==', 'file:///tmp/test.png', 'not a url',
  ]) {
    await assert.rejects(w.fetchImage(url), /allowed wallpaper host|must be https|not a url/, url);
  }
  assert.equal(w.fetches.length, 0);
  assert.equal(w.timers.size, 0);
  assert.deepEqual(manifest.host_permissions, [`https://${wallpaperHost}/*`]);
});

test('valid image requests omit credentials, reject redirects and clean up their timeout', async () => {
  const w = worker(async () => new Response(image, { headers: { 'content-type': 'IMAGE/PNG; charset=binary' } }));
  assert.equal(await w.fetchImage(wallpaper), Buffer.from(image).toString('base64'));
  assert.equal(w.fetches[0].options.redirect, 'error');
  assert.equal(w.fetches[0].options.credentials, 'omit');
  assert.equal(w.fetches[0].options.signal.aborted, true);
  assert.equal(w.timers.size, 0);
});

test('redirect responses never trigger a second request', async () => {
  const w = worker(async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response(null, { status: 302, headers: { location: 'https://[::1]/' } });
  });
  await assert.rejects(w.fetchImage(wallpaper), /HTTP 302/);
  assert.equal(w.fetches.length, 1);
  assert.equal(w.fetches[0].options.signal.aborted, true);
  assert.equal(w.timers.size, 0);
});

test('declared oversized images are rejected before reading their stream', async () => {
  let reads = 0;
  const w = worker(async () => new Response(new ReadableStream({
    pull() { reads++; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'image/png', 'content-length': String(8 * 1024 * 1024 + 1) } }));
  await assert.rejects(w.fetchImage(wallpaper), /larger than 8MB/);
  assert.equal(reads, 0);
  assert.equal(w.fetches[0].options.signal.aborted, true);
  assert.equal(w.timers.size, 0);
});

for (const declaredLength of [undefined, '1']) {
  test(`stream limit aborts an oversized response with ${declaredLength ? 'a false' : 'no'} Content-Length`, async () => {
    let chunks = 0;
    let cancelled = false;
    const w = worker(async () => new Response(new ReadableStream({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (chunks === 100) controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'image/png', ...(declaredLength ? { 'content-length': declaredLength } : {}) } }));
    await assert.rejects(w.fetchImage(wallpaper), /larger than 8MB/);
    assert.equal(chunks, 9, 'stop at the first chunk crossing the limit, not the end of the body');
    assert.equal(cancelled, true);
    assert.equal(w.fetches[0].options.signal.aborted, true);
    assert.equal(w.timers.size, 0);
  });
}

test('an image exactly 8 MiB is accepted without altering its bytes', async () => {
  const input = new Uint8Array(8 * 1024 * 1024).fill(123);
  input.set(image);
  const w = worker(async () => new Response(input, { headers: { 'content-type': 'image/png' } }));
  assert.equal(await w.fetchImage(wallpaper), Buffer.from(input).toString('base64'));
  assert.equal(w.timers.size, 0);
});

for (const stage of ['headers', 'body']) {
  test(`download deadline aborts stalled ${stage} and releases the installation slot`, async () => {
    const w = worker(async (_url, { signal }) => {
      if (stage === 'headers') return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }), { headers: { 'content-type': 'image/png' } });
    });
    const request = w.install({ backgroundUrl: wallpaper });
    await flush();
    for (let i = 0; i < 20; i++) assert.match((await w.install()).error, /in progress/);
    assert.equal(w.fetches.length, 1);
    w.fire(w.DOWNLOAD_TIMEOUT_MS);
    assert.match((await request).error, /download timed out/);
    assert.equal(w.timers.size, 0);
    assert.equal(w.posts.length, 0);
    const next = w.install();
    w.finish();
    assert.equal((await next).ok, true);
    assert.equal(w.timers.size, 0);
  });
}

for (const [name, response] of [
  ['HTTP failure', () => new Response(null, { status: 500 })],
  ['invalid MIME', () => new Response(image, { headers: { 'content-type': 'image/png+xml' } })],
  ['empty image', () => new Response(null, { headers: { 'content-type': 'image/png' } })],
  ['empty stream', () => new Response(new Uint8Array(), { headers: { 'content-type': 'image/png' } })],
  ['network failure', () => { throw new Error('network failed'); }],
  ['stream failure', () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream failed')); } }), { headers: { 'content-type': 'image/png' } })],
]) {
  test(`${name} does not leave an active timer or installation`, async () => {
    const w = worker(async () => response());
    assert.equal((await w.install({ backgroundUrl: wallpaper })).ok, false);
    assert.equal(w.timers.size, 0);
    assert.equal(w.posts.length, 0);
    const next = w.install();
    w.finish();
    assert.equal((await next).ok, true);
  });
}

test('installation admission lasts until the host replies and transports bounded image data', async () => {
  const w = worker(async () => new Response(image, { headers: { 'content-type': 'image/png' } }));
  const first = w.install({ backgroundUrl: wallpaper });
  await flush();
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].background, Buffer.from(image).toString('base64'));
  assert.match((await w.install({ backgroundUrl: wallpaper })).error, /in progress/);
  assert.equal(w.fetches.length, 1);
  w.finish();
  assert.equal((await first).ok, true);
  assert.equal(w.timers.size, 0);
});

for (const failure of ['timeout', 'disconnect', 'post']) {
  test(`native ${failure} releases installation admission and settles only once`, async () => {
    const w = worker();
    if (failure === 'post') w.ports[0].postMessage = () => { throw new Error('port lost'); };
    const request = w.install();
    if (failure === 'timeout') w.fire(w.INSTALL_TIMEOUT_MS);
    if (failure === 'disconnect') w.ports[0].onDisconnect.emit();
    assert.equal((await request).ok, false);
    if (failure === 'timeout') {
      for (let i = 0; i < 4; i++) assert.match((await w.install()).error, /in progress/);
      assert.equal(w.posts.length, 1, 'timeout must not queue additional native work');
      w.finish();
      await flush();
    }
    assert.equal(request.replies.length, 1, 'each caller receives exactly one response');
    const next = w.install();
    w.finish();
    assert.equal((await next).ok, true);
    assert.ok([...w.timers.values()].every(({ delay }) => delay === 1000), 'only a reconnect timer may remain');
  });
}

test('a timed-out native installation releases admission on disconnection', async () => {
  const w = worker();
  const request = w.install();
  w.fire(w.INSTALL_TIMEOUT_MS);
  assert.equal((await request).ok, false);
  assert.match((await w.install()).error, /in progress/);
  w.ports[0].onDisconnect.emit();
  await flush();
  const next = w.install();
  w.finish();
  assert.equal((await next).ok, true);
});

test('invalid or oversized specifications are rejected before downloading or posting', async () => {
  const w = worker();
  const many = { ...colors };
  for (let i = 0; i < 126; i++) many[`extra${i}`] = '#123456';
  for (const extra of [
    { name: '' }, { name: 'x'.repeat(65) }, { name: 'Review\n' }, { name: {} },
    { colors: many }, { colors: [] }, { colors: null }, { colors: { accent: '#123456' } },
    { colors: { ...colors, ['x'.repeat(33)]: '#123456' } },
    { colors: { ...colors, 'extra\n': '#123456' } }, { colors: { ...colors, extra: '#123456\n' } },
    { colors: { ...colors, extra: 3 } }, { backgroundUrl: {} }, { backgroundUrl: 'x'.repeat(4097) },
  ]) {
    assert.match((await w.install({ backgroundUrl: wallpaper, ...extra })).error, /invalid theme specification/);
  }
  assert.equal(w.fetches.length, 0);
  assert.equal(w.posts.length, 0);
  assert.equal(w.timers.size, 0);
});

test('all bundled gallery specifications and exact schema boundaries remain valid', async () => {
  const w = worker(async () => new Response(image, { headers: { 'content-type': 'image/png' } }));
  const maximum = { ...colors, ['x'.repeat(32)]: '#ABCDEF' };
  for (let i = 0; i < 124; i++) maximum[`extra${i}`] = '#123456';
  for (const spec of [...themes, { name: 'x'.repeat(64), colors: maximum, background: wallpaper }]) {
    const request = w.install({ name: spec.name, colors: spec.colors, backgroundUrl: spec.background });
    await flush();
    assert.equal(w.posts.at(-1)?.name, spec.name);
    w.finish();
    assert.equal((await request).ok, true);
  }
  assert.equal(w.fetches.length, themes.length + 1);
  assert.equal(w.timers.size, 0);
});
