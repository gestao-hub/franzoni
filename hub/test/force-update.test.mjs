import { describe, expect, it } from 'vitest';
import { resolveForceUpdatePaths } from '../force-update.mjs';

describe('force-update paths', () => {
  it('resolve config e releases relativos contra Root no Windows', () => {
    const resolved = resolveForceUpdatePaths({
      configArg: 'config.json',
      root: 'C:\\Exped',
      platform: 'win32',
      cwd: 'C:\\Windows\\System32',
      rawPaths: { releasesDir: 'releases', releasesPtr: 'releases/current' },
    });

    expect(resolved.configPath).toBe('C:\\Exped\\config.json');
    expect(resolved.releasesDir).toBe('C:\\Exped\\releases');
    expect(resolved.ptrPath).toBe('C:\\Exped\\releases\\current');
    expect(JSON.stringify(resolved)).not.toContain('System32');
  });
});
