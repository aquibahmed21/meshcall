import { describe, expect, it } from 'vitest';
import { GOOGLE_STUN } from '../../src/config';

describe('GOOGLE_STUN', () => {
  it('is a non-empty array of stun: URLs used as last-resort fallback', () => {
    expect(Array.isArray(GOOGLE_STUN)).toBe(true);
    expect(GOOGLE_STUN.length).toBeGreaterThan(0);
    GOOGLE_STUN.forEach((u) => expect(u).toMatch(/^stun:/));
  });
});
