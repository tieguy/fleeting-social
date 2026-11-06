// JSON files in one directory, one per document.
//
// Each write goes to a temporary file that then replaces the old file, so a
// crash leaves the old or the new file, never half of one. `update` holds a
// per-document lock across its read-modify-write, so two requests in this
// process cannot lose each other's change. Files are mode 600 and the
// directory 700.
//
// `read` goes to disk every time. The admin command (`admin.js`) writes the
// same files from another process, and a revoked device must stop working
// at once.

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function createStore(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const locks = new Map();

  function path(name) {
    if (!/^[a-z-]+$/.test(name)) throw new Error(`bad document name: ${name}`);
    return join(dir, `${name}.json`);
  }

  async function read(name, fallback) {
    try {
      return JSON.parse(await readFile(path(name), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return structuredClone(fallback);
      throw e;
    }
  }

  async function write(name, value) {
    const file = path(name);
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, file);
  }

  // Runs `fn(current)` under the document's lock, writes the document it
  // returns and resolves to it. If `fn` throws, nothing is written.
  function update(name, fallback, fn) {
    const prev = locks.get(name) || Promise.resolve();
    const run = prev.then(async () => {
      const next = await fn(await read(name, fallback));
      await write(name, next);
      return next;
    });
    // The next caller waits for this one, whether it failed or not
    const settled = run.catch(() => {});
    locks.set(name, settled);
    settled.then(() => {
      if (locks.get(name) === settled) locks.delete(name);
    });
    return run;
  }

  return { read, update };
}
