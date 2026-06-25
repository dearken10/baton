/**
 * Tests for batonHome() / applyBatonUserDataOverride() — the single
 * source of truth for baton's on-disk data dir. Verifies the BATON_HOME
 * override (which is what lets multiple instances coexist) and the
 * `~/.baton` default, plus the Electron `userData` relocation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const { setPath } = vi.hoisted(() => ({ setPath: vi.fn() }));
vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => (key === 'home' ? '/home/tester' : `/x/${key}`),
    setPath,
  },
}));

import { batonHome, applyBatonUserDataOverride } from './paths.js';

const ORIGINAL = process.env['BATON_HOME'];

beforeEach(() => {
  setPath.mockClear();
  delete process.env['BATON_HOME'];
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['BATON_HOME'];
  else process.env['BATON_HOME'] = ORIGINAL;
});

describe('batonHome', () => {
  it('defaults to ~/.baton when BATON_HOME is unset', () => {
    expect(batonHome()).toBe(join('/home/tester', '.baton'));
  });

  it('honours BATON_HOME when set', () => {
    process.env['BATON_HOME'] = '/tmp/baton-work';
    expect(batonHome()).toBe('/tmp/baton-work');
  });

  it('ignores an empty BATON_HOME and falls back to the default', () => {
    process.env['BATON_HOME'] = '';
    expect(batonHome()).toBe(join('/home/tester', '.baton'));
  });
});

describe('applyBatonUserDataOverride', () => {
  it('relocates userData under BATON_HOME when set', () => {
    process.env['BATON_HOME'] = '/tmp/baton-work';
    applyBatonUserDataOverride();
    expect(setPath).toHaveBeenCalledWith('userData', join('/tmp/baton-work', 'electron'));
  });

  it('is a no-op when BATON_HOME is unset', () => {
    applyBatonUserDataOverride();
    expect(setPath).not.toHaveBeenCalled();
  });
});
