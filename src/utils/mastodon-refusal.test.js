import { describe, expect, it, vi } from 'vitest';

vi.mock('./account-sync', () => ({ reportMastodonRefusal: () => {} }));
vi.mock('./store-utils', () => ({ getAccounts: () => [] }));

const { refusedMastodonAccount } = await import('./mastodon-refusal');

const masto = {
  info: { id: '42' },
  instanceURL: 'social.example',
  accessToken: 'tok',
};
const bluesky = {
  accountType: 'bluesky',
  info: { id: 'did:plc:a' },
  instanceURL: 'social.example',
  accessToken: 'tok',
};

describe('refusedMastodonAccount', () => {
  it('finds the Mastodon account whose token the request carried', () => {
    expect(
      refusedMastodonAccount({
        url: 'https://Social.Example/api/v1/timelines/home',
        authorization: 'Bearer tok',
        accounts: [bluesky, masto],
      }),
    ).toBe(masto);
  });

  it('ignores another token, another server, or no token', () => {
    const accounts = [masto];
    const url = 'https://social.example/api/v1/x';
    expect(
      refusedMastodonAccount({ url, authorization: 'Bearer other', accounts }),
    ).toBe(null);
    expect(
      refusedMastodonAccount({
        url: 'https://elsewhere.example/api/v1/x',
        authorization: 'Bearer tok',
        accounts,
      }),
    ).toBe(null);
    expect(refusedMastodonAccount({ url, authorization: null, accounts })).toBe(
      null,
    );
  });
});
