// /admin/users/[userId] now redirects to the Staff Permission page, which
// renders the same user detail view. Old bookmarks and deep links keep working.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ redirect: vi.fn() }));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import UserDetailRedirectPage from './page';

beforeEach(() => {
  mocks.redirect.mockReset();
});

describe('UserDetailRedirectPage', () => {
  it('redirects to staff-permission with the user id', async () => {
    await UserDetailRedirectPage({
      params: Promise.resolve({ orgSlug: 'shadhil-builders', userId: 'user-1' }),
    });
    expect(mocks.redirect).toHaveBeenCalledWith(
      '/shadhil-builders/admin/staff-permission?userId=user-1',
    );
  });

  it('URL-encodes the user id', async () => {
    await UserDetailRedirectPage({
      params: Promise.resolve({ orgSlug: 'shadhil-builders', userId: 'a&b=c' }),
    });
    expect(mocks.redirect).toHaveBeenCalledWith(
      '/shadhil-builders/admin/staff-permission?userId=a%26b%3Dc',
    );
  });
});
