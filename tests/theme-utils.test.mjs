import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/theme-utils.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const utils = context.OmarchyThemeUtils;

const miasma = utils.normalizePalette({
  background: '#222222',
  dark_background: '#191919',
  darker_background: '#121212',
  lighter_background: '#2c2c2c',
  foreground: '#c2c2b0',
  light_foreground: '#8a8a7e',
  muted: '#666666',
  accent: '#78824b',
  red: '#685742',
  yellow: '#b36d43',
  green: '#5f875f',
  cyan: '#c9a554',
  blue: '#78824b',
  magenta: '#bb7744',
}, 'dark');

test('parses browser computed colors and preserves alpha', () => {
  assert.deepEqual({ ...utils.parseColor('rgb(17, 34, 51)') }, { r: 17, g: 34, b: 51, a: 1 });
  assert.deepEqual({ ...utils.parseColor('rgba(17, 34, 51, 0.25)') }, { r: 17, g: 34, b: 51, a: 0.25 });
  assert.deepEqual({ ...utils.parseColor('#abc') }, { r: 170, g: 187, b: 204, a: 1 });
  assert.equal(utils.parseColor('transparent'), null);
});

test('maps neutral page surfaces into the exact Omarchy surface roles', () => {
  assert.equal(utils.transformBackground('rgb(255, 255, 255)', miasma), '#222222');
  assert.equal(utils.transformBackground('rgb(190, 190, 190)', miasma), '#2c2c2c');
  assert.equal(utils.transformBackground('rgb(100, 100, 100)', miasma), '#191919');
  assert.equal(utils.transformBackground('rgb(0, 0, 0)', miasma), '#121212');
  assert.equal(utils.transformBackground('rgba(255, 255, 255, 0)', miasma), null);
});

test('preserves the narrow surface hierarchy used by native dark web apps', () => {
  const chatGptCanvas = utils.luminance('#212121');
  assert.equal(utils.transformBackground('#0d0d0d', miasma, 'dark', chatGptCanvas), '#121212');
  assert.equal(utils.transformBackground('#171717', miasma, 'dark', chatGptCanvas), '#191919');
  assert.equal(utils.transformBackground('#212121', miasma, 'dark', chatGptCanvas), '#222222');
  assert.equal(utils.transformBackground('#2f2f2f', miasma, 'dark', chatGptCanvas), '#2c2c2c');
  assert.equal(utils.transformBackground('#323232', miasma, 'dark', chatGptCanvas), '#2c2c2c');
});

test('maps a native black canvas to the primary theme background', () => {
  const blackCanvas = utils.luminance('#000000');
  assert.equal(utils.transformBackground('#000000', miasma, 'dark', blackCanvas), '#222222');
  assert.equal(utils.transformBackground('#171717', miasma, 'dark', blackCanvas), '#2c2c2c');
});

test('maps links, neutral text, semantic colors, and borders into the palette', () => {
  assert.equal(utils.transformText('rgb(20, 20, 20)', miasma), '#c2c2b0');
  assert.equal(utils.transformText('rgb(194, 194, 176)', miasma), '#c2c2b0');
  assert.equal(utils.transformText('rgb(138, 138, 126)', miasma), '#8a8a7e');
  assert.equal(utils.transformText('rgb(85, 85, 85)', miasma), '#c2c2b0');
  assert.equal(utils.transformText('rgb(20, 20, 20)', miasma, 'link'), '#78824b');
  assert.equal(utils.transformText('rgb(220, 30, 20)', miasma), '#685742');
  assert.match(utils.transformBorder('rgb(210, 210, 210)', miasma), /^#[0-9a-f]{6}$/);
});

test('derives complete light and dark palettes from the three required colors', () => {
  for (const mode of ['light', 'dark']) {
    const palette = utils.normalizePalette({
      background: mode === 'light' ? '#eeeeee' : '#111111',
      foreground: mode === 'light' ? '#111111' : '#eeeeee',
      accent: '#336699',
    }, mode);
    assert.equal(palette.mode, mode);
    for (const key of ['background', 'darker', 'dark', 'lighter', 'foreground', 'muted', 'faint', 'accent', 'selection']) {
      assert.match(palette[key], /^#[0-9a-f]{6}$/i, key);
    }
  }
});
