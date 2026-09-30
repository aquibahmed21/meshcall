import { describe, expect, it } from 'vitest';
import { GOOGLE_STUN, orderStunUrls } from '../../src/config';

describe('STUN server order', () => {
  it("Google's STUN servers always come first, then the configured ones", () => {
    expect(orderStunUrls(['stun:aahlaad.in:3478'])).toEqual([...GOOGLE_STUN, 'stun:aahlaad.in:3478']);
  });
  it('configured Google entries and duplicates are not repeated; order of others kept', () => {
    expect(orderStunUrls(['stun:b:1', 'stun:stun1.l.google.com:19302', 'stun:a:2', 'stun:b:1'])).toEqual([...GOOGLE_STUN, 'stun:b:1', 'stun:a:2']);
  });
  it('nothing configured → Google only', () => {
    expect(orderStunUrls([])).toEqual(GOOGLE_STUN);
  });
});
