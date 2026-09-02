import { describe, it, expect } from 'vitest';
import { resolveLWW } from '../src/conflict-resolver';

describe('conflict-resolver (LWW)', () => {
  it('returns server when server is newer', () => {
    const result = resolveLWW({ id: '1', updatedAt: 100 }, { id: '1', updatedAt: 200 });
    expect(result.updatedAt).toBe(200);
  });

  it('returns client when client is newer', () => {
    const result = resolveLWW({ id: '1', updatedAt: 200 }, { id: '1', updatedAt: 100 });
    expect(result.updatedAt).toBe(200);
  });

  it('returns server on tie (server-clock-skew-safe)', () => {
    const result = resolveLWW({ id: '1', updatedAt: 100 }, { id: '1', updatedAt: 100 });
    expect(result.updatedAt).toBe(100);
  });
});
