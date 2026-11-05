import './dislike-reasons.css';

import { Trans, useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'preact/hooks';

import { muteWordEverywhere } from '../utils/mute-word';
import showToast from '../utils/show-toast';

function hashtagsOf(status) {
  const names = (status.tags || []).map((t) => t.name);
  return [...new Set(names.filter(Boolean).map((n) => n.toLowerCase()))];
}

// The reasons offered after "Not for me", in the For You page and the For
// You lab. Each one but "Just this post" also acts: it mutes or blocks the
// author on the post's network, or mutes a word on every logged-in account,
// so the dislike and the fix are one tap. Blocking asks for no confirmation.
// `masto` is a client on the post's network.
function DislikeReasons({ status, masto, given = [], onReason }) {
  const { t } = useLingui();
  const account = status.account;
  const [busy, setBusy] = useState(false);
  const [word, setWord] = useState('');
  const selection = useRef('');
  const done = (type, value) =>
    given.some((r) => r.type === type && r.value === value);

  async function act(type, value, action) {
    if (busy || done(type, value)) return;
    setBusy(true);
    try {
      if (action) await action();
      onReason({ type, value });
    } catch (e) {
      console.error(e);
      showToast(t`Failed: ${e?.message || e}`);
    }
    setBusy(false);
  }

  async function muteWord(value) {
    const word = (value || '').trim();
    if (!word) return;
    await act('mute-word', word, async () => {
      const instances = await muteWordEverywhere(word, { expiresIn: 0 });
      if (!instances.length) throw new Error(t`No account accepted the mute`);
      const where = instances.join(', ');
      showToast(t`Muted "${word}" on ${where}`);
    });
  }

  const button = (type, value, label, action) => (
    <button
      type="button"
      class={done(type, value) ? '' : 'light'}
      disabled={busy}
      onClick={() => act(type, value, action)}
    >
      {done(type, value) ? `✓ ${label}` : label}
    </button>
  );

  const acct = account?.acct;
  const tags = hashtagsOf(status);

  return (
    <div class="lab-reasons">
      <span class="insignificant">
        <Trans>Why?</Trans>
      </span>
      {button('post', '', t`Just this post`)}
      {button('mute-author', acct, t`Mute @${acct}`, () =>
        masto.v1.accounts.$select(account.id).mute(),
      )}
      {button('block-author', acct, t`Block`, () =>
        masto.v1.accounts.$select(account.id).block(),
      )}
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          class={done('mute-word', tag) ? '' : 'light'}
          disabled={busy}
          onClick={() => muteWord(tag)}
        >
          {done('mute-word', tag) ? t`✓ Muted ${tag}` : t`Mute #${tag}`}
        </button>
      ))}
      <button
        type="button"
        class="light"
        disabled={busy}
        // Read the selection before the tap can clear it
        onPointerDown={() => {
          selection.current = String(window.getSelection() || '').trim();
        }}
        onClick={() => {
          const text =
            selection.current || String(window.getSelection() || '').trim();
          if (text) muteWord(text);
          else showToast(t`Select a word or phrase in the post first`);
        }}
      >
        <Trans>Mute selected text</Trans>
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          muteWord(word).then(() => setWord(''));
        }}
      >
        <input
          type="text"
          placeholder={t`Mute a word…`}
          value={word}
          onInput={(e) => setWord(e.target.value)}
          disabled={busy}
        />
      </form>
      {given
        .filter((r) => r.type === 'mute-word' && !tags.includes(r.value))
        .map((r) => (
          <span key={r.value} class="insignificant">
            <Trans>✓ Muted "{r.value}"</Trans>
          </span>
        ))}
    </div>
  );
}

export default DislikeReasons;
