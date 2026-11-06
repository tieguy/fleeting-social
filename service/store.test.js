import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createStore } from './store.js';

async function tempStore() {
  const dir = join(await mkdtemp(join(tmpdir(), 'fleeting-store-')), 'data');
  return { dir, store: await createStore(dir) };
}

describe('createStore', () => {
  it('returns the fallback for a missing document', async () => {
    const { store } = await tempStore();
    expect(await store.read('foryou', { a: 1 })).toEqual({ a: 1 });
  });

  it('writes files mode 600 in a directory mode 700', async () => {
    const { dir, store } = await tempStore();
    await store.update('foryou', {}, () => ({ a: 1 }));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'foryou.json'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['foryou.json']);
  });

  it('serializes updates so none is lost', async () => {
    const { store } = await tempStore();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.update('count', { n: 0 }, async (doc) => {
          await new Promise((r) => setTimeout(r, 1));
          return { n: doc.n + 1 };
        }),
      ),
    );
    expect(await store.read('count', null)).toEqual({ n: 20 });
  });

  it('writes nothing when the update throws, and goes on', async () => {
    const { store } = await tempStore();
    await store.update('doc', {}, () => ({ v: 1 }));
    await expect(
      store.update('doc', {}, () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    await store.update('doc', {}, (d) => ({ v: d.v + 1 }));
    expect(await store.read('doc', null)).toEqual({ v: 2 });
  });

  it('refuses a document name that is a path', async () => {
    const { store } = await tempStore();
    await expect(store.read('../x', null)).rejects.toThrow();
  });
});
