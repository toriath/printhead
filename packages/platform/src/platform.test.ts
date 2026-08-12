import { describe, expect, it } from 'vitest';
import {
  createManualClock,
  createMemoryPlatform,
  createMemoryStorage,
  createSystemClock,
} from './index.js';

describe('clock facade', () => {
  it('advances a manual clock deterministically', () => {
    const clock = createManualClock(1000);
    expect(clock.nowMs()).toBe(1000);
    clock.advance(500);
    expect(clock.nowMs()).toBe(1500);
  });

  it('never moves backwards', () => {
    expect(() => createManualClock().advance(-1)).toThrow(RangeError);
  });

  it('exposes the system clock behind the same interface', () => {
    expect(typeof createSystemClock().nowMs()).toBe('number');
  });
});

describe('storage facade', () => {
  it('round-trips values and lists keys', async () => {
    const storage = createMemoryStorage();
    expect(await storage.read('save')).toBeNull();
    await storage.write('save', '{"version":1}');
    expect(await storage.read('save')).toBe('{"version":1}');
    expect(await storage.keys()).toEqual(['save']);
    await storage.remove('save');
    expect(await storage.keys()).toEqual([]);
  });

  it('seeds from an initial record', async () => {
    const storage = createMemoryStorage({ a: '1' });
    expect(await storage.read('a')).toBe('1');
  });
});

describe('memory platform', () => {
  it('bundles a manual clock and memory storage', () => {
    const platform = createMemoryPlatform(42);
    expect(platform.id).toBe('memory');
    expect(platform.clock.nowMs()).toBe(42);
  });
});
