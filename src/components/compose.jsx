import './compose.css';

import { msg, plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { MenuDivider, MenuItem } from '@szhsin/react-menu';
import { deepEqual } from 'fast-equals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import punycode from 'punycode/';
import { useHotkeys } from 'react-hotkeys-hook';
import { uid } from 'uid/single';
import { useSnapshot } from 'valtio';

import supportedLanguages from '../data/status-supported-languages';
import { accountRoster } from '../utils/acting-accounts';
import { api, getPreferences } from '../utils/api';
import { isBlueskyAccount, isBlueskyInstance } from '../utils/bluesky';
import { blueskyInstanceInfo } from '../utils/bluesky/convert';
import {
  countableBlueskyText,
  countableText,
  shouldEnforceCharLimit,
  validateSegments,
} from '../utils/compose-counting';
import db from '../utils/db';
import { getDtfLocale } from '../utils/dtf-locale';
import haptics from '../utils/haptics';
import localeMatch from '../utils/locale-match';
import localeCode2Text from '../utils/localeCode2Text';
import mem from '../utils/mem';
import openCompose from '../utils/open-compose';
import {
  buildCrossSegments,
  canCrossPost,
  publishThread,
} from '../utils/publish';
import {
  getPostQuoteApprovalPolicy,
  supportsNativeQuote,
} from '../utils/quote-utils';
import RTF from '../utils/relative-time-format';
import showToast from '../utils/show-toast';
import states, { saveStatus } from '../utils/states';
import store from '../utils/store';
import {
  getAPIVersions,
  getAccountByInstance,
  getAccounts,
  getCurrentAccount,
  getCurrentAccountNS,
  getCurrentInstanceConfiguration,
  getInstanceConfigurationByDomain,
} from '../utils/store-utils';
import stringLength from '../utils/string-length';
import supports from '../utils/supports';
import unfurlMastodonLink from '../utils/unfurl-link';
import useCloseWatcher from '../utils/useCloseWatcher';
import useInterval from '../utils/useInterval';
import useThrottledResizeObserver from '../utils/useThrottledResizeObserver';
import visibilityIconsMap from '../utils/visibility-icons-map';
import visibilityText from '../utils/visibility-text';

import AccountBlock from './account-block';
import { AccountPickerCheckboxes } from './account-picker';
// import Avatar from './avatar';
import CameraCaptureInput, {
  supportsCameraCapture,
} from './camera-capture-input';
import CharCountMeter from './char-count-meter';
import ComposePoll, { expiryOptions } from './compose-poll';
import Textarea from './compose-textarea';
import CustomEmojisModal from './custom-emojis-modal';
import FilePickerInput from './file-picker-input';
import GIFPickerModal from './gif-picker-modal';
import Icon from './icon';
import Loader from './loader';
import MediaAttachment from './media-attachment';
import MentionModal from './mention-modal';
import Menu2 from './menu2';
import Modal from './modal';
import QuoteSuggestion from './quote-suggestion';
import ScheduledAtField, {
  getLocalTimezoneName,
  MIN_SCHEDULED_AT,
} from './ScheduledAtField';
import Status from './status';
import TextExpander from './text-expander';
import ThreadSegmentEditor from './thread-segment-editor';

const supportedLanguagesMap = supportedLanguages.reduce((acc, l) => {
  const [code, common, native] = l;
  acc[code] = {
    common,
    native,
  };
  return acc;
}, {});

// Convert camelCase to kebab-case for language codes
// e.g., "mnMong" → "mn-Mong", "msArab" → "ms-Arab"
const camelToKebabCase = (str) => {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2');
};

/* NOTES:
  - Max character limit includes BOTH status text and Content Warning text
*/

// Detect devices that can't open proper custom-sized windows
// (Android phones/tablets, iOS devices, but not Chromebooks)
const isPopOutNotSupported =
  /Android|iPhone|iPad|iPod/.test(navigator.userAgent) &&
  !/CrOS/.test(navigator.userAgent);

const expirySeconds = Object.keys(expiryOptions);
const oneDay = 24 * 60 * 60;

const expiresInFromExpiresAt = (expiresAt) => {
  if (!expiresAt) return oneDay;
  const delta = (Date.parse(expiresAt) - Date.now()) / 1000;
  return expirySeconds.find((s) => s >= delta) || oneDay;
};

const DEFAULT_LANG = localeMatch(
  [getDtfLocale(), ...navigator.languages],
  supportedLanguages.map((l) => l[0]),
  'en',
);

// const rtf = new Intl.RelativeTimeFormat();
const LF = mem((locale) => new Intl.ListFormat(locale || undefined));

const ADD_LABELS = {
  camera: msg`Take photo or video`,
  media: msg`Add media`,
  customEmoji: msg`Add custom emoji`,
  gif: msg`Add GIF`,
  poll: msg`Add poll`,
  sensitive: msg`Add content warning`,
  scheduledPost: msg`Schedule post`,
};

const DEFAULT_SCHEDULED_AT = Math.max(10 * 60 * 1000, MIN_SCHEDULED_AT); // 10 mins
const MAX_THREAD_SEGMENTS = 25;

function isMimeTypeSupported(fileType, supportedMimeTypes) {
  if (!supportedMimeTypes) return true;
  if (supportedMimeTypes.includes(fileType)) return true;

  // If type is not supported, try to find a supported type with the same subtype
  // E.g. application/ogg -> audio/ogg
  const [suffixType, subtype] = fileType.split('/');
  const subTypeMap = {};
  supportedMimeTypes.forEach((mimeType) => {
    const [t, st] = mimeType.split('/');
    subTypeMap[st] = t;
  });

  return !!subTypeMap[subtype];
}

function fixLanguage(language) {
  if (!language || typeof language !== 'string') return null;
  // If inside list, return it, else fix it
  if (supportedLanguagesMap[language]) return language;
  const fixedLanguage = camelToKebabCase(language);
  if (supportedLanguagesMap[fixedLanguage]) {
    return fixedLanguage;
  }
  return null;
}

function Compose({
  onClose,
  replyToStatus,
  replyMode = 'all',
  editStatus,
  draftStatus,
  quoteStatus,
  standalone,
  hasOpener,
  sharedData,
}) {
  const { i18n, _, t } = useLingui();
  const rtf = RTF(i18n.locale);
  const lf = LF(i18n.locale);

  console.warn('RENDER COMPOSER');
  // Replies/edits/quotes of a post from another network/instance (e.g. a
  // Bluesky post in the merged timeline) must be posted through that
  // network's client. A plain mention carries the target's network via
  // draftStatus._instance so the handle is posted from an account on that
  // network (otherwise a cross-network mention is inert — see mention-network).
  const targetInstance =
    replyToStatus?._instance ||
    editStatus?._instance ||
    quoteStatus?._instance ||
    draftStatus?._instance ||
    null;
  const { masto, instance } = targetInstance
    ? api({ instance: targetInstance })
    : api();
  const isBlueskyTarget = isBlueskyInstance(instance);
  const [uiState, setUIState] = useState('default');
  const UID = useRef(draftStatus?.uid || uid());
  console.log('Compose UID', UID.current);

  // The account that will actually post: the one owning targetInstance
  // when set (cross-account replies/quotes/edits), else the current one
  const currentAccount = useMemo(
    () =>
      (targetInstance && getAccountByInstance(targetInstance)) ||
      getCurrentAccount(),
    [],
  );
  const currentAccountInfo = currentAccount.info;

  const configuration = isBlueskyTarget
    ? blueskyInstanceInfo(instance).configuration
    : targetInstance
      ? getInstanceConfigurationByDomain(instance)
      : getCurrentInstanceConfiguration();
  console.log('⚙️ Configuration', configuration);

  // Compose targets: for a new post or a quote, EVERY logged-in account is
  // a peer checkbox — the active account is not special, and a post can go
  // only to a non-active account. Replies/edits stay network-bound (they
  // belong to one thread on one instance); quotes fan out — native on
  // targets that can quote, the quoted post's URL appended elsewhere.
  const composeTargetable = !editStatus && !replyToStatus;
  const targetRoster = useMemo(
    () =>
      composeTargetable
        ? accountRoster({
            accounts: getAccounts(),
            currentID: currentAccount.info.id,
          })
        : [],
    [],
  );
  // Persisted as the UNCHECKED set so newly-added accounts default to
  // checked (matching the all-checked default) and removed accounts
  // vanish harmlessly.
  const [uncheckedIDs, setUncheckedIDs] = useState(
    () => new Set(store.local.getJSON('composeUncheckedAccounts') || []),
  );
  const checkedTargets = targetRoster.filter(
    (a) => !uncheckedIDs.has(a.info.id),
  );
  // The mount-time account (media upload, drafts, char counting) — when
  // unchecked, its publish is skipped and every checked account posts
  // through the re-upload path.
  const primaryChecked =
    !composeTargetable || !uncheckedIDs.has(currentAccount.info.id);
  const crossTargets = checkedTargets.filter(
    (a) => a.info.id !== currentAccount.info.id,
  );

  const {
    statuses: {
      maxCharacters,
      maxMediaAttachments, // Beware: it can be undefined!
      charactersReservedPerUrl,
    } = {},
    mediaAttachments: {
      supportedMimeTypes,
      imageSizeLimit,
      imageMatrixLimit,
      videoSizeLimit,
      videoMatrixLimit,
      videoFrameRateLimit,
      descriptionLimit,
    } = {},
    polls: {
      maxOptions,
      maxCharactersPerOption,
      maxExpiration,
      minExpiration,
    } = {},
  } = configuration || {};

  const supportedImagesVideosTypes = supportedMimeTypes?.filter((mimeType) =>
    /^(image|video)/i.test(mimeType),
  );

  const textareaRef = useRef();
  const spoilerTextRef = useRef();

  // Declare these early for use in crossPostToBluesky calculation
  const [visibility, setVisibility] = useState('public');
  const [poll, setPoll] = useState(null);
  const [scheduledAt, setScheduledAt] = useState(null);

  const BLUESKY_MAX_CHARACTERS = 300;
  // When cross-posting to a Bluesky account, the strictest limit binds.
  const crossPostToBluesky =
    canCrossPost({ poll, scheduledAt, visibility }) &&
    crossTargets.some((a) => isBlueskyAccount(a));
  const effectiveMaxCharacters =
    crossPostToBluesky && maxCharacters > BLUESKY_MAX_CHARACTERS
      ? BLUESKY_MAX_CHARACTERS
      : maxCharacters;
  const charLimitBoundByBluesky =
    effectiveMaxCharacters === BLUESKY_MAX_CHARACTERS &&
    maxCharacters !== BLUESKY_MAX_CHARACTERS;

  const [quoteApprovalPolicy, setQuoteApprovalPolicy] = useState('public');
  const [sensitive, setSensitive] = useState(false);
  const [sensitiveMedia, setSensitiveMedia] = useState(false);
  const [language, setLanguage] = useState(
    store.session.get('currentLanguage') || DEFAULT_LANG,
  );
  const prevLanguage = useRef(language);
  const [mediaAttachments, setMediaAttachments] = useState([]);
  const [moreSegments, setMoreSegments] = useState([]);
  const [quoteSuggestion, setQuoteSuggestion] = useState(null);
  const [localQuoteStatus, setLocalQuoteStatus] = useState(quoteStatus);
  const [quoteCleared, setQuoteCleared] = useState(false);
  // Survives a failed publish attempt so retry can resume mid-thread.
  // Non-null ONLY for genuine partial threads: { postedStatuses: [...], lastPostedId }
  const [threadPublishState, setThreadPublishState] = useState(null);
  const [publishProgress, setPublishProgress] = useState(null); // 'n/N' string

  const prefs = getPreferences();

  const currentQuoteStatus = quoteCleared
    ? null
    : localQuoteStatus || quoteStatus;

  // Quote eligibility logic duplicated from status.jsx
  const checkQuoteEligibility = (status) => {
    if (!supportsNativeQuote(instance)) return false;

    const { visibility, quoteApproval, account } = status;
    const isSelf = currentAccountInfo && currentAccountInfo.id === account.id;
    const isPublic = ['public', 'unlisted'].includes(visibility);
    const isMineAndPrivate = isSelf && visibility === 'private';

    const isQuoteAutomaticallyAccepted =
      quoteApproval?.currentUser === 'automatic' &&
      (isPublic || isMineAndPrivate);
    const isQuoteManuallyAccepted =
      quoteApproval?.currentUser === 'manual' && (isPublic || isMineAndPrivate);

    if (!isPublic && !isSelf) {
      return false;
    } else if (isQuoteAutomaticallyAccepted) {
      return true;
    } else if (isQuoteManuallyAccepted) {
      return true;
    } else {
      return false;
    }
  };

  const processFiles = async (
    files,
    currentCount = mediaAttachments.length,
  ) => {
    const supportedFiles = [];
    const unsupportedFiles = [];
    for (const file of files || []) {
      if (!isMimeTypeSupported(file.type, supportedMimeTypes)) {
        unsupportedFiles.push(file);
      } else {
        supportedFiles.push(file);
      }
    }

    if (unsupportedFiles.length > 0) {
      alert(
        plural(unsupportedFiles.length, {
          one: `File ${unsupportedFiles[0].name} is not supported.`,
          other: `Files ${lf.format(
            unsupportedFiles.map((f) => f.name),
          )} are not supported.`,
        }),
      );
    }

    if (supportedFiles.length > 0) {
      // Auto-cut-off files to avoid exceeding maxMediaAttachments
      let allowedFiles = supportedFiles;
      if (maxMediaAttachments !== undefined) {
        const max = maxMediaAttachments - currentCount;
        if (max <= 0) {
          alert(
            plural(maxMediaAttachments, {
              one: 'You can only attach up to 1 file.',
              other: 'You can only attach up to # files.',
            }),
          );
          return;
        }
        allowedFiles = allowedFiles.slice(0, max);
      }
      return Promise.all(
        allowedFiles.map(async (file) => ({
          fileData: await file.arrayBuffer(),
          fileName: file.name,
          type: file.type,
          size: file.size,
          url: URL.createObjectURL(file),
          id: null,
          description: null,
        })),
      );
    }
    return null;
  };

  const handlePastedLink = async (url) => {
    // Handle QP links
    if (supportsNativeQuote(instance)) {
      // Quotes cannot coexist with media attachments or polls
      if (mediaAttachments.length > 0 || poll) {
        return;
      }

      // Cannot add/remove/replace current quote when editing
      if (editStatus) {
        return;
      }

      // Don't show quote suggestion when visibility is 'direct'
      if (visibility === 'direct') {
        return;
      }

      try {
        const unfurledData = await unfurlMastodonLink(instance, url);
        if (unfurledData?.id) {
          const status =
            states.statuses[`${unfurledData.instance}/${unfurledData.id}`];
          if (status && checkQuoteEligibility(status)) {
            // Don't show suggestion if it's the same as current quote
            if (currentQuoteStatus?.id === status.id) {
              return;
            }

            setQuoteSuggestion({
              status,
              instance: unfurledData.instance,
              url: unfurledData.originalURL,
            });
          }
        }
      } catch (error) {
        console.error(error);
      }
    }
  };

  const oninputTextarea = () => {
    if (!textareaRef.current) return;
    textareaRef.current.dispatchEvent(new Event('input'));
  };
  const focusTextarea = (cursorPosition) => {
    setTimeout(() => {
      if (!textareaRef.current) return;
      // If cursor position is provided, set it
      if (cursorPosition !== undefined) {
        textareaRef.current.setSelectionRange(cursorPosition, cursorPosition);
      }
      console.debug('FOCUS textarea');
      textareaRef.current?.focus();
    }, 300);
  };
  const insertTextAtCursor = ({ targetElement, text }) => {
    if (!targetElement) return;

    const { selectionStart, selectionEnd, value } = targetElement;
    let textBeforeInsert = value.slice(0, selectionStart);

    // Remove zero-width space from end of text
    textBeforeInsert = textBeforeInsert.replace(/\u200B$/, '');

    const spaceBeforeInsert = textBeforeInsert
      ? /[\s\t\n\r]$/.test(textBeforeInsert)
        ? ''
        : ' '
      : '';

    const textAfterInsert = value.slice(selectionEnd);
    const spaceAfterInsert = /^[\s\t\n\r]/.test(textAfterInsert) ? '' : ' ';

    const newText =
      textBeforeInsert +
      spaceBeforeInsert +
      text +
      spaceAfterInsert +
      textAfterInsert;

    targetElement.value = newText;
    targetElement.selectionStart = targetElement.selectionEnd =
      selectionEnd + text.length + spaceAfterInsert.length;
    targetElement.focus();
    targetElement.dispatchEvent(new Event('input'));
  };

  const lastFocusedFieldRef = useRef(null);
  const lastFocusedEmojiFieldRef = useRef(null);
  const focusLastFocusedField = () => {
    setTimeout(() => {
      if (!lastFocusedFieldRef.current) return;
      lastFocusedFieldRef.current.focus();
    }, 0);
  };
  const composeContainerRef = useRef(null);
  useEffect(() => {
    const handleFocus = (e) => {
      // Toggle focused if in or out if any fields are focused
      composeContainerRef.current.classList.toggle(
        'focused',
        e.type === 'focusin',
      );

      const target = e.target;
      if (target.hasAttribute('data-allow-custom-emoji')) {
        lastFocusedEmojiFieldRef.current = target;
      }
      const isFormElement = ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(
        target.tagName,
      );
      if (isFormElement) {
        lastFocusedFieldRef.current = target;
      }
    };

    const composeContainer = composeContainerRef.current;
    if (composeContainer) {
      composeContainer.addEventListener('focusin', handleFocus);
      composeContainer.addEventListener('focusout', handleFocus);
    }

    return () => {
      if (composeContainer) {
        composeContainer.removeEventListener('focusin', handleFocus);
        composeContainer.removeEventListener('focusout', handleFocus);
      }
    };
  }, []);

  useEffect(() => {
    if (replyToStatus) {
      const { spoilerText, visibility, language, sensitive } = replyToStatus;
      if (spoilerText && spoilerTextRef.current) {
        spoilerTextRef.current.value = spoilerText;
      }
      const mentions = new Set([
        replyToStatus.account.acct,
        ...replyToStatus.mentions.map((m) => m.acct),
      ]);
      const allMentions = [...mentions].filter(
        (m) => m !== currentAccountInfo.acct,
      );

      // Bluesky replies carry the reply relationship in the record itself
      // (clients show "Replying to @x" from reply.parent), and the network
      // convention is no leading @-mention — prefilling one would render as
      // a redundant mention AND send a duplicate mention notification.
      if (allMentions.length > 0 && !isBlueskyTarget) {
        const authorMention = `@${replyToStatus.account.acct}`;
        const otherMentions = allMentions
          .filter((m) => m !== replyToStatus.account.acct)
          .map((m) => `@${m}`);

        if (replyMode === 'author-only') {
          // Mode 1: Only mention the author
          textareaRef.current.value = `${authorMention} `;
          oninputTextarea();
          focusTextarea();
        } else if (replyMode === 'author-first') {
          // Mode 2: Mention author first, then others at the end after 2 newlines
          if (otherMentions.length > 0) {
            textareaRef.current.value = `${authorMention} \n\n${otherMentions.join(' ')}`;
            oninputTextarea();
            // Set cursor position after the author mention
            const cursorPosition = authorMention.length + 1; // +1 for the space
            focusTextarea(cursorPosition);
          } else {
            // If no other mentions, just mention the author
            textareaRef.current.value = `${authorMention} `;
            oninputTextarea();
            focusTextarea();
          }
        } else {
          // Mode 3 (default 'all'): All mentions at the beginning
          textareaRef.current.value = `${allMentions
            .map((m) => `@${m}`)
            .join(' ')} `;
          oninputTextarea();
          focusTextarea();
        }
      }
      setVisibility(
        visibility === 'public' && prefs['posting:default:visibility']
          ? prefs['posting:default:visibility'].toLowerCase()
          : visibility,
      );
      setLanguage(
        fixLanguage(language) ||
          prefs['posting:default:language']?.toLowerCase() ||
          DEFAULT_LANG,
      );
      setSensitive(!!spoilerText);
    } else if (editStatus) {
      const {
        visibility,
        language,
        sensitive,
        poll,
        mediaAttachments,
        quoteApproval,
      } = editStatus;
      const composablePoll = !!poll?.options && {
        ...poll,
        options: poll.options.map((o) => o?.title || o),
        expiresIn: poll?.expiresIn || expiresInFromExpiresAt(poll.expiresAt),
      };
      setUIState('loading');
      (async () => {
        try {
          const statusSource = await masto.v1.statuses
            .$select(editStatus.id)
            .source.fetch();
          console.log({ statusSource });
          const { text, spoilerText } = statusSource;
          textareaRef.current.value = text;
          textareaRef.current.dataset.source = text;
          oninputTextarea();
          focusTextarea();
          spoilerTextRef.current.value = spoilerText;
          setVisibility(visibility);
          setLanguage(
            language ||
              prefs['posting:default:language']?.toLowerCase() ||
              DEFAULT_LANG,
          );
          if (supportsNativeQuote(instance)) {
            const postQuoteApprovalPolicy =
              getPostQuoteApprovalPolicy(quoteApproval);
            setQuoteApprovalPolicy(postQuoteApprovalPolicy);
          }
          setSensitive(sensitive);
          if (composablePoll) setPoll(composablePoll);
          setMediaAttachments(mediaAttachments);
          setUIState('default');
        } catch (e) {
          console.error(e);
          alert(e?.reason || e);
          setUIState('error');
        }
      })();
    } else {
      focusTextarea();
      console.log('Apply prefs', prefs);
      if (prefs['posting:default:visibility']) {
        setVisibility(prefs['posting:default:visibility'].toLowerCase());
      }
      if (prefs['posting:default:language']) {
        setLanguage(prefs['posting:default:language'].toLowerCase());
      }
      if (prefs['posting:default:sensitive']) {
        setSensitive(!!prefs['posting:default:sensitive']);
      }
      if (prefs['posting:default:quote_policy']) {
        let policy = prefs['posting:default:quote_policy'].toLowerCase();
        if (prefs['posting:default:visibility']) {
          const visibility = prefs['posting:default:visibility'].toLowerCase();
          if (visibility === 'private' || visibility === 'direct') {
            policy = 'nobody';
          }
        }
        setQuoteApprovalPolicy(policy);
      }
    }
    if (draftStatus) {
      const {
        status,
        spoilerText,
        visibility,
        language,
        sensitive,
        sensitiveMedia,
        poll,
        mediaAttachments,
        scheduledAt,
        quoteApprovalPolicy,
        moreSegments,
      } = draftStatus;
      const composablePoll = !!poll?.options && {
        ...poll,
        options: poll.options.map((o) => o?.title || o),
        expiresIn: poll?.expiresIn || expiresInFromExpiresAt(poll.expiresAt),
      };
      textareaRef.current.value = status;
      oninputTextarea();
      // status starts with newline or space, focus on first position
      const cursorPos = /^\n|\s/.test(status) ? 0 : undefined;
      focusTextarea(cursorPos);
      if (spoilerText) spoilerTextRef.current.value = spoilerText;
      if (visibility) setVisibility(visibility);
      setLanguage(
        language ||
          prefs['posting:default:language']?.toLowerCase() ||
          DEFAULT_LANG,
      );
      if (sensitiveMedia !== null) setSensitiveMedia(sensitiveMedia);
      if (sensitive !== null) setSensitive(sensitive);
      if (composablePoll) setPoll(composablePoll);
      if (mediaAttachments) setMediaAttachments(mediaAttachments);
      if (scheduledAt) setScheduledAt(scheduledAt);
      if (quoteApprovalPolicy) setQuoteApprovalPolicy(quoteApprovalPolicy);
      if (moreSegments) setMoreSegments(moreSegments);
    }
  }, [draftStatus, editStatus, replyToStatus, replyMode]);

  useEffect(() => {
    if (sharedData) {
      const { initialText, files } = sharedData;

      if (initialText && textareaRef.current) {
        textareaRef.current.value = initialText;
        oninputTextarea();
      }

      if (files && files.length > 0) {
        processFiles(files)
          .then((mediaFiles) => {
            if (mediaFiles) {
              setMediaAttachments(mediaFiles);
            }
          })
          .catch((err) => {
            console.error('Failed to process file(s):', err);
          });
      }
    }
  }, [sharedData]);

  // focus textarea when state.composerState.minimized turns false
  const snapStates = useSnapshot(states);
  useEffect(() => {
    if (!snapStates.composerState.minimized) {
      focusTextarea();
    }
  }, [snapStates.composerState.minimized]);

  const formRef = useRef();

  const beforeUnloadCopy = t`You have unsaved changes. Discard this post?`;
  const canClose = () => {
    const { value, dataset } = textareaRef.current;

    // check if loading
    if (uiState === 'loading') {
      console.log('canClose', { uiState });
      return false;
    }

    // check for status and media attachments
    const hasValue = (value || '')
      .trim()
      .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    const hasMediaAttachments = mediaAttachments.length > 0;
    const hasSegments = moreSegments.some(
      (s) => s.text.trim() || s.mediaAttachments.length,
    );
    if (!hasValue && !hasMediaAttachments && !hasSegments) {
      console.log('canClose', { value, mediaAttachments, hasSegments });
      return true;
    }

    // check if all media attachments have IDs
    const hasIDMediaAttachments =
      mediaAttachments.length > 0 &&
      mediaAttachments.every((media) => media.id);
    if (hasIDMediaAttachments) {
      console.log('canClose', { hasIDMediaAttachments });
      return true;
    }

    // check if status contains only "@acct", if replying
    const isSelf = replyToStatus?.account.id === currentAccountInfo.id;
    const hasOnlyAcct =
      replyToStatus && value.trim() === `@${replyToStatus.account.acct}`;
    // TODO: check for mentions, or maybe just generic "@username<space>", including multiple mentions like "@username1<space>@username2<space>"
    if (!isSelf && hasOnlyAcct) {
      console.log('canClose', { isSelf, hasOnlyAcct });
      return true;
    }

    // check if status is same with source
    const sameWithSource = value === dataset?.source;
    if (sameWithSource) {
      console.log('canClose', { sameWithSource });
      return true;
    }

    console.log('canClose', {
      value,
      hasMediaAttachments,
      hasIDMediaAttachments,
      poll,
      isSelf,
      hasOnlyAcct,
      sameWithSource,
      uiState,
    });

    return false;
  };

  const confirmClose = () => {
    if (!canClose()) {
      const yes = confirm(beforeUnloadCopy);
      return yes;
    }
    return true;
  };

  useEffect(() => {
    // Show warning if user tries to close window with unsaved changes
    const handleBeforeUnload = (e) => {
      if (!canClose()) {
        e.preventDefault();
        e.returnValue = beforeUnloadCopy;
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload, {
      capture: true,
    });
    return () =>
      window.removeEventListener('beforeunload', handleBeforeUnload, {
        capture: true,
      });
  }, []);

  const getCharCount = () => {
    const { value } = textareaRef.current;
    const { value: spoilerText } = spoilerTextRef.current;
    // Mastodon shortens URLs to a fixed length for counting purposes;
    // Bluesky posts get their link text shortened at publish time
    // (shortenLinkFacets), so count that shortened form.
    // When cross-posting to Bluesky, use Bluesky's strictest counting rules.
    const useBlueskyRules = isBlueskyTarget || charLimitBoundByBluesky;
    const text = useBlueskyRules
      ? countableBlueskyText(value)
      : countableText(value);
    // Only count spoilerText when sensitive is active (both meter and validator must agree)
    const spoilerCount = sensitive ? stringLength(spoilerText) : 0;
    return stringLength(text) + spoilerCount;
  };
  const updateCharCount = () => {
    const count = getCharCount();
    states.composerCharacterCount = count;
  };
  useEffect(updateCharCount, [charLimitBoundByBluesky, sensitive]);

  const supportsCloseWatcher = window.CloseWatcher;
  const escDownRef = useRef(false);
  useHotkeys(
    'esc',
    () => {
      escDownRef.current = true;
      // This won't be true if this event is already handled and not propagated 🤞
    },
    {
      enabled: !supportsCloseWatcher,
      enableOnFormTags: true,
      useKey: true,
      ignoreEventWhen: (e) => e.metaKey || e.ctrlKey || e.altKey || e.shiftKey,
    },
  );
  useHotkeys(
    'esc',
    () => {
      if (!standalone && escDownRef.current && confirmClose()) {
        onClose();
      }
      escDownRef.current = false;
    },
    {
      enabled: !supportsCloseWatcher,
      enableOnFormTags: true,
      // Use keyup because Esc keydown will close the confirm dialog on Safari
      keyup: true,
      ignoreEventWhen: (e) => {
        const modals = document.querySelectorAll('#modal-container > *');
        const hasModal = !!modals;
        const hasOnlyComposer =
          modals.length === 1 && modals[0].querySelector('#compose-container');
        return (
          (hasModal && !hasOnlyComposer) ||
          e.metaKey ||
          e.ctrlKey ||
          e.altKey ||
          e.shiftKey
        );
      },
      useKey: true,
    },
  );
  useCloseWatcher(() => {
    if (!standalone && confirmClose()) {
      onClose();
    }
  }, []);

  const prevBackgroundDraft = useRef({});
  const draftKey = () => {
    const ns = getCurrentAccountNS();
    return `${ns}#${UID.current}`;
  };
  const saveUnsavedDraft = () => {
    // Not enabling this for editing status
    // I don't think this warrant a draft mode for a status that's already posted
    // Maybe it could be a big edit change but it should be rare
    if (editStatus) return;
    if (states.composerState.minimized) return;
    // Session-scoped resume state must not leak into a restorable draft.
    // A browser reload would restore all segments with no record that some posted,
    // making the Post button a from-zero duplicate trap. Skip entirely while resuming.
    if (threadPublishState) return;
    const key = draftKey();
    const backgroundDraft = {
      key,
      replyTo: replyToStatus
        ? {
            /* Smaller payload of replyToStatus. Reasons:
              - No point storing whole thing
              - Could have media attachments
              - Could be deleted/edited later
            */
            id: replyToStatus.id,
            account: {
              id: replyToStatus.account.id,
              username: replyToStatus.account.username,
              acct: replyToStatus.account.acct,
            },
          }
        : null,
      draftStatus: {
        uid: UID.current,
        status: textareaRef.current.value,
        spoilerText: spoilerTextRef.current.value,
        visibility,
        language,
        sensitive,
        sensitiveMedia,
        poll,
        mediaAttachments,
        scheduledAt,
        quoteApprovalPolicy,
        moreSegments,
      },
      quote: currentQuoteStatus?.id
        ? {
            // Smaller payload, same reason as replyTo
            id: currentQuoteStatus.id,
          }
        : null,
    };
    if (
      !deepEqual(backgroundDraft, prevBackgroundDraft.current) &&
      !canClose()
    ) {
      console.debug('not equal', backgroundDraft, prevBackgroundDraft.current);
      db.drafts
        .set(key, {
          ...backgroundDraft,
          state: 'unsaved',
          updatedAt: Date.now(),
        })
        .then(() => {
          console.debug('DRAFT saved', key, backgroundDraft);
        })
        .catch((e) => {
          console.error('DRAFT failed', key, e);
        });
      prevBackgroundDraft.current = structuredClone(backgroundDraft);
    }
  };
  useInterval(saveUnsavedDraft, 5000); // background save every 5s
  useEffect(() => {
    saveUnsavedDraft();
    // If unmounted, means user discarded the draft
    // Also means pop-out 🙈, but it's okay because the pop-out will persist the ID and re-create the draft
    return () => {
      db.drafts.del(draftKey());
    };
  }, []);

  useEffect(() => {
    const handleItems = (e) => {
      // Ignore drops when a sheet is open
      if (document.querySelector('.sheet')) return;

      const { items } = e.clipboardData || e.dataTransfer;
      const files = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          files.push(item.getAsFile());
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        processFiles(files)
          .then((mediaFiles) => {
            if (mediaFiles) {
              setMediaAttachments((prev) => [...prev, ...mediaFiles]);
            }
          })
          .catch((err) => {
            console.error('Failed to process file(s):', err);
          });
      }
    };
    window.addEventListener('paste', handleItems);
    const handleDragover = (e) => {
      // Prevent default if there's files
      if (e.dataTransfer.items.length > 0) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('dragover', handleDragover);
    window.addEventListener('drop', handleItems);
    return () => {
      window.removeEventListener('paste', handleItems);
      window.removeEventListener('dragover', handleDragover);
      window.removeEventListener('drop', handleItems);
    };
  }, [mediaAttachments]);

  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [showEmoji2Picker, setShowEmoji2Picker] = useState(false);
  const [showGIFPicker, setShowGIFPicker] = useState(false);

  const [autoDetectedLanguages, setAutoDetectedLanguages] = useState(null);
  const [topSupportedLanguages, restSupportedLanguages] = useMemo(() => {
    const topLanguages = [];
    const restLanguages = [];
    const { contentTranslationHideLanguages = [] } = states.settings;
    supportedLanguages.forEach((l) => {
      const [code] = l;
      if (
        code === language ||
        code === prevLanguage.current ||
        code === DEFAULT_LANG ||
        contentTranslationHideLanguages.includes(code) ||
        (autoDetectedLanguages?.length && autoDetectedLanguages.includes(code))
      ) {
        topLanguages.push(l);
      } else {
        restLanguages.push(l);
      }
    });
    topLanguages.sort(([codeA, commonA], [codeB, commonB]) => {
      if (codeA === language) return -1;
      if (codeB === language) return 1;
      return commonA.localeCompare(commonB);
    });
    restLanguages.sort(([codeA, commonA], [codeB, commonB]) =>
      commonA.localeCompare(commonB),
    );
    return [topLanguages, restLanguages];
  }, [language, autoDetectedLanguages]);

  const replyToStatusMonthsAgo = useMemo(
    () =>
      !!replyToStatus?.createdAt &&
      Math.floor(
        (Date.now() - Date.parse(replyToStatus.createdAt)) /
          (1000 * 60 * 60 * 24 * 30),
      ),
    [replyToStatus],
  );

  const onMinimize = () => {
    saveUnsavedDraft();
    states.composerState.minimized = true;
  };

  const mediaButtonDisabled =
    uiState === 'loading' ||
    (maxMediaAttachments !== undefined &&
      mediaAttachments.length >= maxMediaAttachments); /* ||
    !!poll ||
    !!currentQuoteStatus?.id; */

  const cwButtonDisabled = uiState === 'loading' || !!sensitive;
  const onCWButtonClick = () => {
    setSensitive(true);
    setTimeout(() => {
      spoilerTextRef.current?.focus();
    }, 0);
  };

  // If maxOptions is not defined or defined and is greater than 1, show poll button
  const showPollButton = maxOptions == null || maxOptions > 1;
  const pollButtonDisabled = uiState === 'loading' || !!poll; /* ||
    !!mediaAttachments.length ||
    !!currentQuoteStatus?.id; */
  const onPollButtonClick = () => {
    setPoll({
      options: ['', ''],
      expiresIn: 24 * 60 * 60, // 1 day
      multiple: false,
    });
    // Focus first choice field
    setTimeout(() => {
      composeContainerRef.current
        ?.querySelector('.poll-choice input[type="text"]')
        ?.focus();
    }, 0);
  };

  const highlightLanguageField =
    language !== prevLanguage.current ||
    (autoDetectedLanguages?.length &&
      !autoDetectedLanguages.includes(language));
  const highlightVisibilityField = visibility !== 'public';

  const highlightQuoteApprovalPolicyField = quoteApprovalPolicy !== 'public';
  const disableQuotePolicy =
    visibility === 'private' || visibility === 'direct';

  const addSubToolbarRef = useRef();
  const [showAddButton, setShowAddButton] = useState(true);
  const BUTTON_WIDTH = 42; // roughly one button width
  useThrottledResizeObserver({
    ref: addSubToolbarRef,
    box: 'border-box',
    onResize: ({ width }) => {
      // If scrollable, it's truncated
      const { scrollWidth } = addSubToolbarRef.current;
      const truncated = scrollWidth > width;
      const overTruncated = width < BUTTON_WIDTH * 4;
      setShowAddButton(overTruncated || truncated);
      addSubToolbarRef.current.hidden = overTruncated;
    },
  });

  const showScheduledAt = !editStatus;
  const scheduledAtButtonDisabled =
    uiState === 'loading' || !!scheduledAt || moreSegments.length > 0;
  const scheduledAtButtonTitle =
    moreSegments.length > 0 ? t`Threads can't be scheduled` : undefined;
  const onScheduledAtClick = () => {
    const date = new Date(Date.now() + DEFAULT_SCHEDULED_AT);
    setScheduledAt(date);
  };

  return (
    <div id="compose-container-outer" ref={composeContainerRef}>
      <div
        id="compose-container"
        tabIndex={-1}
        class={standalone ? 'standalone' : ''}
      >
        <div class="compose-top">
          {currentAccountInfo?.avatarStatic && (
            // <Avatar
            //   url={currentAccountInfo.avatarStatic}
            //   size="xl"
            //   alt={currentAccountInfo.username}
            //   squircle={currentAccountInfo?.bot}
            // />
            <AccountBlock
              account={currentAccountInfo}
              accountInstance={currentAccount.instanceURL}
              hideDisplayName
              useAvatarStatic
            />
          )}
          {!standalone ? (
            <span class="compose-controls">
              {!isPopOutNotSupported && (
                <button
                  type="button"
                  class="plain4 pop-button"
                  disabled={uiState === 'loading'}
                  onClick={() => {
                    // If there are non-ID media attachments (not yet uploaded), show confirmation dialog because they are not going to be passed to the new window
                    // const containNonIDMediaAttachments =
                    //   mediaAttachments.length > 0 &&
                    //   mediaAttachments.some((media) => !media.id);
                    // if (containNonIDMediaAttachments) {
                    //   const yes = confirm(
                    //     'You have media attachments that are not yet uploaded. Opening a new window will discard them and you will need to re-attach them. Are you sure you want to continue?',
                    //   );
                    //   if (!yes) {
                    //     return;
                    //   }
                    // }

                    // const mediaAttachmentsWithIDs = mediaAttachments.filter(
                    //   (media) => media.id,
                    // );

                    const newWin = openCompose({
                      editStatus,
                      replyToStatus,
                      draftStatus: {
                        uid: UID.current,
                        status: textareaRef.current.value,
                        spoilerText: spoilerTextRef.current.value,
                        visibility,
                        language,
                        sensitive,
                        poll,
                        mediaAttachments,
                        scheduledAt,
                      },
                      quoteStatus: currentQuoteStatus,
                    });

                    if (!newWin) {
                      return;
                    }

                    onClose();
                  }}
                >
                  <Icon icon="popout" alt={t`Pop out`} />
                </button>
              )}
              <button
                type="button"
                class="plain4 min-button"
                onClick={onMinimize}
              >
                <Icon icon="minimize" alt={t`Minimize`} />
              </button>{' '}
              <button
                type="button"
                class="plain4 close-button"
                disabled={uiState === 'loading'}
                onClick={() => {
                  if (confirmClose()) {
                    onClose();
                  }
                }}
              >
                <Icon icon="x" alt={t`Close`} />
              </button>
            </span>
          ) : (
            hasOpener && (
              <button
                type="button"
                class="light pop-button"
                disabled={uiState === 'loading'}
                onClick={() => {
                  // If there are non-ID media attachments (not yet uploaded), show confirmation dialog because they are not going to be passed to the new window
                  // const containNonIDMediaAttachments =
                  //   mediaAttachments.length > 0 &&
                  //   mediaAttachments.some((media) => !media.id);
                  // if (containNonIDMediaAttachments) {
                  //   const yes = confirm(
                  //     'You have media attachments that are not yet uploaded. Opening a new window will discard them and you will need to re-attach them. Are you sure you want to continue?',
                  //   );
                  //   if (!yes) {
                  //     return;
                  //   }
                  // }

                  if (!window.opener) {
                    alert(t`Looks like you closed the parent window.`);
                    return;
                  }

                  if (window.opener.__STATES__.showCompose) {
                    if (window.opener.__STATES__.composerState?.publishing) {
                      alert(
                        t`Looks like you already have a compose field open in the parent window and currently publishing. Please wait for it to be done and try again later.`,
                      );
                      return;
                    }

                    let confirmText = t`Looks like you already have a compose field open in the parent window. Popping in this window will discard the changes you made in the parent window. Continue?`;
                    const yes = confirm(confirmText);
                    if (!yes) return;
                  }

                  // const mediaAttachmentsWithIDs = mediaAttachments.filter(
                  //   (media) => media.id,
                  // );

                  onClose({
                    fn: () => {
                      const passData = {
                        editStatus,
                        replyToStatus,
                        replyMode,
                        draftStatus: {
                          uid: UID.current,
                          status: textareaRef.current.value,
                          spoilerText: spoilerTextRef.current.value,
                          visibility,
                          language,
                          sensitive,
                          sensitiveMedia,
                          poll,
                          mediaAttachments,
                          scheduledAt,
                        },
                        quoteStatus: currentQuoteStatus,
                      };
                      window.opener.__COMPOSE__ = passData; // Pass it here instead of `showCompose` due to some weird proxy issue again
                      if (window.opener.__STATES__.showCompose) {
                        window.opener.__STATES__.showCompose = false;
                        setTimeout(() => {
                          window.opener.__STATES__.showCompose = true;
                        }, 10);
                      } else {
                        window.opener.__STATES__.showCompose = true;
                      }
                      if (window.opener.__STATES__.composerState.minimized) {
                        // Maximize it
                        window.opener.__STATES__.composerState.minimized = false;
                      }
                    },
                  });
                }}
              >
                <Icon icon="popin" alt={t`Pop in`} />
              </button>
            )
          )}
        </div>
        {!!replyToStatus && (
          <details class="status-preview" open>
            <Status status={replyToStatus} size="s" previewMode />
            <summary class="status-preview-legend reply-to">
              {replyToStatusMonthsAgo > 0 ? (
                <Trans>
                  Replying to @
                  {replyToStatus.account.acct
                    ? punycode.toUnicode(replyToStatus.account.acct)
                    : replyToStatus.account.username}
                  &rsquo;s post (
                  <strong>
                    {rtf.format(-replyToStatusMonthsAgo, 'month')}
                  </strong>
                  )
                </Trans>
              ) : (
                <Trans>
                  Replying to @
                  {replyToStatus.account.acct
                    ? punycode.toUnicode(replyToStatus.account.acct)
                    : replyToStatus.account.username}
                  &rsquo;s post
                </Trans>
              )}
            </summary>
          </details>
        )}
        {!!editStatus && (
          <details class="status-preview">
            <Status status={editStatus} size="s" previewMode />
            <summary class="status-preview-legend">
              <Trans>Editing source post</Trans>
            </summary>
          </details>
        )}
        <form
          ref={formRef}
          class={`form-visibility-${visibility}`}
          style={{
            pointerEvents: uiState === 'loading' ? 'none' : 'auto',
            opacity: uiState === 'loading' ? 0.5 : 1,
          }}
          onClick={() => {
            setTimeout(() => {
              if (!document.activeElement) {
                lastFocusedFieldRef.current?.focus?.();
              }
            }, 10);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              // Validate that main post is not empty when posting a thread
              // Media-only posts are legal via the button (no text required)
              if (moreSegments.length > 0 && mediaAttachments.length === 0) {
                const mainText = (textareaRef.current?.value || '').trim();
                if (!mainText) {
                  alert(t`The first post can't be empty`);
                  return;
                }
              }
              formRef.current.dispatchEvent(
                new Event('submit', { cancelable: true }),
              );
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();

            const formData = new FormData(e.target);
            const entries = Object.fromEntries(formData.entries());
            console.log('ENTRIES', entries);
            // `visibility` and `sensitiveMedia` deliberately come from React
            // state, NOT FormData: their controls are disabled while retrying
            // a partially-posted thread, and disabled controls drop out of
            // FormData — which would silently change the remaining segments'
            // visibility/sensitivity mid-thread. Both are controlled inputs,
            // so state is always current.
            let {
              status,
              sensitive,
              spoilerText,
              scheduledAt,
              quoteApprovalPolicy,
            } = entries;

            // Pre-cleanup
            // checkboxes return "on" if checked
            sensitive = sensitive === 'on';

            // Convert datetime-local input value to RFC3339 Date string value
            scheduledAt = scheduledAt
              ? new Date(scheduledAt).toISOString()
              : undefined;

            // Validation
            /* Let the backend validate this
          if (stringLength(status) > maxCharacters) {
            alert(`Status is too long! Max characters: ${maxCharacters}`);
            return;
          }
          if (
            sensitive &&
            stringLength(status) + stringLength(spoilerText) > maxCharacters
          ) {
            alert(
              `Status and content warning is too long! Max characters: ${maxCharacters}`,
            );
            return;
          }
          */
            if (poll) {
              if (poll.options.length < 2) {
                alert(t`Poll must have at least 2 options`);
                return;
              }
              if (poll.options.some((option) => option === '')) {
                alert(t`Some poll choices are empty`);
                return;
              }
            }

            // Validate all segments (including moreSegments)
            const blueskyRules =
              charLimitBoundByBluesky ||
              maxCharacters === BLUESKY_MAX_CHARACTERS;

            const enforceCharLimit = shouldEnforceCharLimit(
              effectiveMaxCharacters,
              maxCharacters,
              moreSegments.length,
            );
            const validationError = validateSegments({
              mainText: status || '',
              moreSegments,
              spoilerText,
              sensitive,
              effectiveMaxCharacters,
              enforceCharLimit,
              blueskyRules,
              stringLength,
            });

            if (validationError) {
              const { segmentIndex, reason } = validationError;
              if (reason === 'empty') {
                alert(t`Thread segments cannot be empty`);
              } else if (reason === 'too-long') {
                if (segmentIndex === 0) {
                  alert(
                    t`Your post is too long for this network — max characters: ${effectiveMaxCharacters}`,
                  );
                } else {
                  alert(
                    t`Post #${segmentIndex} is too long — max characters: ${effectiveMaxCharacters}`,
                  );
                }
              }
              return;
            }

            // TODO: check for URLs and use `charactersReservedPerUrl` to calculate max characters

            if (mediaAttachments.length > 0) {
              // If there are media attachments, check if they have no descriptions
              const hasNoDescriptions = mediaAttachments.some(
                (media) => !media.description?.trim?.(),
              );
              if (hasNoDescriptions) {
                const yes = confirm(
                  t`Some media have no descriptions. Continue?`,
                );
                if (!yes) return;
              }
            }

            // Post-cleanup
            spoilerText = (sensitive && spoilerText) || undefined;
            status = status === '' ? undefined : status;

            // states.composerState.minimized = true;
            states.composerState.publishing = true;
            setUIState('loading');
            (async () => {
              try {
                // Polls, scheduling and non-public visibility can only
                // publish through the primary account's own network. If the
                // primary is unchecked, nothing could post — stop before
                // uploading anything.
                if (
                  composeTargetable &&
                  !primaryChecked &&
                  !canCrossPost({ poll, scheduledAt, visibility })
                ) {
                  states.composerState.publishing = false;
                  setUIState('default');
                  alert(
                    t`Polls, scheduled posts and non-public visibility can only be posted from @${
                      currentAccount.info.acct || currentAccount.info.username
                    } — select that account, or remove those options.`,
                  );
                  return;
                }
                console.log('MEDIA ATTACHMENTS', mediaAttachments);
                // Media pre-upload goes to the primary account's instance;
                // when the primary is unchecked, skip it — every checked
                // account re-uploads from fileData in publishThread.
                if (primaryChecked && mediaAttachments.length > 0) {
                  // Upload media attachments first
                  const mediaPromises = mediaAttachments.map((attachment) => {
                    const { fileData, fileName, file, type, description, id } =
                      attachment;
                    console.log('UPLOADING', attachment);
                    if (id) {
                      // If already uploaded
                      return attachment;
                    } else {
                      // Reconstruct File from fileData, or fall back to legacy file object
                      const fileObj = fileData
                        ? new File([fileData], fileName || 'upload', { type })
                        : file;
                      const params = removeNullUndefined({
                        file: fileObj,
                        description,
                      });
                      return masto.v2.media.create(params).then((res) => {
                        if (res.id) {
                          attachment.id = res.id;
                        }
                        return res;
                      });
                    }
                  });
                  const results = await Promise.allSettled(mediaPromises);

                  // If any failed, return
                  if (
                    results.some((result) => {
                      return result.status === 'rejected' || !result.value?.id;
                    })
                  ) {
                    states.composerState.publishing = false;
                    states.composerState.publishingError = true;
                    setUIState('error');
                    // Alert all the reasons
                    results.forEach((result) => {
                      if (result.status === 'rejected') {
                        console.error(result);
                        alert(result.reason || t`Attachment #${i} failed`);
                      }
                    });
                    return;
                  }

                  console.log({ results, mediaAttachments });
                }

                /* NOTE:
                Using snakecase here because masto.js's `isObject` returns false for `params`, ONLY happens when opening in pop-out window. This is maybe due to `window.masto` variable being passed from the parent window. The check that failed is `x.constructor === Object`, so maybe the `Object` in new window is different than parent window's?
                Code: https://github.com/neet/masto.js/blob/dd0d649067b6a2b6e60fbb0a96597c373a255b00/src/serializers/is-object.ts#L2

                // TODO: Note above is no longer true in Masto.js v6. Revisit this.
              */
                let newStatus;
                if (editStatus) {
                  let params = {
                    status,
                    // spoilerText,
                    spoiler_text: spoilerText,
                    language,
                    sensitive: sensitive || sensitiveMedia,
                    poll,
                    // mediaIds: mediaAttachments.map((attachment) => attachment.id),
                    media_ids: mediaAttachments.map(
                      (attachment) => attachment.id,
                    ),
                  };
                  if (supportsNativeQuote(instance)) {
                    params.quote_approval_policy = quoteApprovalPolicy;
                  }
                  if (
                    supports('@mastodon') ||
                    supports('@gotosocial/edit-media-attributes')
                  ) {
                    params.media_attributes = mediaAttachments.map(
                      (attachment) => {
                        return {
                          id: attachment.id,
                          description: attachment.description,
                          // focus
                          // thumbnail
                        };
                      },
                    );
                  }
                  params = removeNullUndefined(params);
                  newStatus = await masto.v1.statuses
                    .$select(editStatus.id)
                    .update(params);
                  saveStatus(newStatus, instance, {
                    skipThreading: true,
                  });
                } else {
                  // The primary (mount-time) account posts through the
                  // composer's own client; unchecked → skip, and the
                  // checked accounts below carry the post alone.
                  if (primaryChecked) {
                    const shared = {
                      visibility,
                      language,
                      spoilerText,
                      sensitive: sensitive || sensitiveMedia,
                      inReplyToId: replyToStatus?.id || undefined,
                      scheduledAt,
                    };
                    if (supportsNativeQuote(instance)) {
                      shared.quoteApprovalPolicy = quoteApprovalPolicy;
                      if (currentQuoteStatus?.id) {
                        shared.quotedStatusId = currentQuoteStatus.id;
                      }
                    }
                    const segments = [
                      {
                        text: status,
                        mediaIds: mediaAttachments.map(
                          (attachment) => attachment.id,
                        ),
                        poll,
                      },
                      ...moreSegments.map((segment) => ({
                        text: segment.text,
                        // publishThread uploads these to the target (fileData path)
                        mediaAttachments: segment.mediaAttachments,
                      })),
                    ];
                    // Orphan-root guard: if lastPostedId is falsy, resuming would
                    // silently restart the chain as a detached root. Decide from a
                    // LOCAL before calling the setter — setThreadPublishState(null)
                    // doesn't change this render's closure binding, so deriving
                    // resume/startAt from threadPublishState after the setter would
                    // still resume with the stale object.
                    const canResume = !!threadPublishState?.lastPostedId;
                    if (threadPublishState && !canResume) {
                      setThreadPublishState(null);
                    }
                    // Resume state exists ONLY for genuine partial threads (some posts up,
                    // some not). Plain single-post failures and index-0 thread failures keep
                    // today's behavior exactly — no "Retry remaining", no locking.
                    const resume = canResume;
                    const startAt = resume
                      ? threadPublishState.postedStatuses.length
                      : 0;
                    const { statuses, failedAtIndex, error } =
                      await publishThread({
                        masto,
                        instance,
                        isBluesky: isBlueskyTarget, // compose.jsx:201 — explicit, never duck-typed
                        segments,
                        shared,
                        idempotencyPrefix: UID.current,
                        startAt,
                        resumeInReplyToId: resume
                          ? threadPublishState.lastPostedId
                          : undefined,
                        onProgress: (i, state) => {
                          if (state === 'posting' && segments.length > 1) {
                            const progress = `${i + 1}/${segments.length}`;
                            setPublishProgress(progress);
                            // Mirror into global composer state so the minimized-composer
                            // indicator can show it too (design asked for composerState here;
                            // the resume bookkeeping itself stays component-local — recorded
                            // as a minor deviation).
                            states.composerState.publishingProgress = progress;
                          }
                        },
                      });
                    const allStatuses = [
                      ...(threadPublishState?.postedStatuses || []),
                      ...statuses,
                    ];
                    if (failedAtIndex !== null) {
                      // Clear transient progress on every failure path too — leaving it
                      // stale would show "Posting 2/3…" on an idle errored composer
                      setPublishProgress(null);
                      states.composerState.publishingProgress = null;
                      if (segments.length > 1 && allStatuses.length > 0) {
                        // Genuine partial thread → enable resume UX
                        setThreadPublishState({
                          postedStatuses: allStatuses,
                          lastPostedId: allStatuses.at(-1)?.id || null,
                        });
                        // The pre-failure draft on disk still holds every segment
                        // with no record that some posted — restoring it after a
                        // reload would republish from zero. Delete it; resume
                        // state is deliberately session-scoped.
                        db.drafts.del(draftKey());
                        const msg =
                          error?.reason || error?.message || `${error}`;
                        throw Object.assign(
                          error || new Error('thread failed'),
                          {
                            _threadPartial: {
                              posted: allStatuses.length,
                              total: segments.length,
                              msg,
                            },
                          },
                        );
                      }
                      // Nothing posted (or not a thread): behave exactly like today
                      setThreadPublishState(null);
                      // Bluesky atomic failure warning: if connection dropped mid-post on
                      // the server side, a blind retry duplicates the whole thread
                      if (isBlueskyTarget && segments.length > 1) {
                        throw Object.assign(
                          error || new Error('thread failed'),
                          {
                            _blueskyAtomicWarning: true,
                          },
                        );
                      }
                      throw error;
                    }
                    setThreadPublishState(null);
                    setPublishProgress(null);
                    states.composerState.publishingProgress = null;
                    newStatus = allStatuses[0];

                    // Hoist isThread for clarity
                    const isThread = moreSegments.length > 0;

                    // Clear moreSegments on success
                    if (isThread) {
                      setMoreSegments([]);
                    }
                  } // end primaryChecked

                  // Post to every other checked account (either network)
                  if (crossTargets.length) {
                    if (canCrossPost({ poll, scheduledAt, visibility })) {
                      const crossSegments = buildCrossSegments({
                        status,
                        mediaAttachments,
                        moreSegments,
                      });
                      // A quote fans out per target: a Bluesky quote is
                      // native on EVERY Bluesky account (ids are
                      // network-global) and a link everywhere else; a
                      // Mastodon quote is native only on accounts on the
                      // quoted post's own instance (API v7+). Cross-instance
                      // Mastodon quoting (search resolution) is out of
                      // scope — those targets get the link.
                      const quoteIsBluesky =
                        currentQuoteStatus?._bluesky ||
                        isBlueskyInstance(currentQuoteStatus?._instance);
                      const crossShared = {
                        spoilerText,
                        sensitive: sensitive || sensitiveMedia,
                        language,
                        visibility: visibility || 'public',
                      };
                      for (const account of crossTargets) {
                        const acctName =
                          account.info.acct || account.info.username;
                        try {
                          const nativeQuote = currentQuoteStatus
                            ? quoteIsBluesky
                              ? isBlueskyAccount(account)
                              : account.instanceURL ===
                                  currentQuoteStatus?._instance &&
                                supportsNativeQuote(account.instanceURL)
                            : false;
                          // Link targets carry the quoted post's URL on
                          // segment 0. The char counter counts only the
                          // typed text, so the appended URL can push a link
                          // target over its server limit — the per-target
                          // failure toast reports that.
                          const targetSegments = nativeQuote
                            ? crossSegments
                            : currentQuoteStatus?.url
                              ? [
                                  {
                                    ...crossSegments[0],
                                    text: `${crossSegments[0].text}\n${currentQuoteStatus.url}`,
                                  },
                                  ...crossSegments.slice(1),
                                ]
                              : crossSegments;
                          const {
                            statuses: crossStatuses,
                            failedAtIndex: crossFailedAt,
                            error: crossError,
                            skippedMedia,
                          } = await publishThread({
                            account,
                            segments: targetSegments,
                            shared: nativeQuote
                              ? {
                                  ...crossShared,
                                  quotedStatusId: currentQuoteStatus.id,
                                  quoteApprovalPolicy,
                                }
                              : crossShared,
                            onProgress: (i, state) => {
                              if (
                                state === 'posting' &&
                                crossSegments.length > 1
                              ) {
                                states.composerState.publishingProgress = `@${acctName} ${
                                  i + 1
                                }/${crossSegments.length}`;
                              }
                            },
                          });
                          if (crossFailedAt !== null) {
                            // Partial cross-post: report precisely what made it
                            // up. Single posts keep the original failure copy —
                            // "0 of 1 posts" reads worse than "Unable to".
                            showToast(
                              crossSegments.length > 1
                                ? t`Cross-posted ${crossStatuses.length} of ${crossSegments.length} posts to @${acctName} — the rest failed: ${
                                    crossError?.message || crossError
                                  }`
                                : t`Unable to cross-post to @${acctName}: ${
                                    crossError?.message || crossError
                                  }`,
                            );
                            continue;
                          }
                          showToast(
                            (crossSegments.length > 1
                              ? t`Cross-posted thread (${crossStatuses.length} posts) to @${acctName}`
                              : t`Cross-posted to @${acctName}`) +
                              (skippedMedia?.length
                                ? ` (${t`some attachments skipped`})`
                                : ''),
                          );
                        } catch (e) {
                          console.error(e);
                          showToast(
                            t`Unable to cross-post to @${acctName}: ${
                              e?.message || e
                            }`,
                          );
                        }
                      }
                    } else {
                      showToast(
                        t`Cross-posting skipped (not supported for polls, scheduled or non-public posts)`,
                      );
                    }
                  }
                  states.composerState.publishingProgress = null;
                }
                states.composerState.minimized = false;
                states.composerState.publishing = false;
                setUIState('default');

                // Close
                onClose({
                  // type: post, reply, edit
                  type: editStatus ? 'edit' : replyToStatus ? 'reply' : 'post',
                  newStatus,
                  instance,
                  scheduledAt,
                });
              } catch (e) {
                states.composerState.publishing = false;
                states.composerState.publishingProgress = null;
                states.composerState.publishingError = true;
                console.error(e);
                // Handle partial thread failure with resume UX
                if (e?._threadPartial) {
                  const { posted, total, msg } = e._threadPartial;
                  alert(
                    t`Posted ${posted} of ${total} thread posts. The rest failed (${msg}). Your remaining posts are still here — press "Retry remaining".`,
                  );
                } else if (e?._blueskyAtomicWarning) {
                  const msg = e?.reason || e?.message || `${e}`;
                  alert(
                    t`Thread failed to post. If the connection dropped mid-post, it may have gone through on Bluesky — check your profile before retrying to avoid duplicating the thread. Error: ${msg}`,
                  );
                } else {
                  const msg = e?.reason || e?.message || `${e}`;
                  if (/session.*(deleted|expired|revoked)/i.test(msg)) {
                    alert(
                      'Your session has expired. Please log out and log back in.',
                    );
                  } else {
                    alert(msg);
                  }
                }
                setUIState('error');
              }
            })();
          }}
        >
          <div>
            <div class={`compose-cw-container ${sensitive ? '' : 'collapsed'}`}>
              <input
                type="hidden"
                name="sensitive"
                value={sensitive ? 'on' : 'off'}
              />
              {/* mimic the old checkbox */}
              <TextExpander
                keys=":"
                class="spoiler-text-field-container"
                onTrigger={(action) => {
                  if (action?.name === 'custom-emojis') {
                    setShowEmoji2Picker({
                      targetElement: spoilerTextRef,
                      defaultSearchTerm: action?.defaultSearchTerm || null,
                    });
                  }
                }}
              >
                <input
                  ref={spoilerTextRef}
                  type="text"
                  name="spoilerText"
                  placeholder={t`Content warning`}
                  data-allow-custom-emoji="true"
                  disabled={uiState === 'loading'}
                  readOnly={!!threadPublishState}
                  title={
                    threadPublishState
                      ? t`Locked while retrying a partially-posted thread`
                      : undefined
                  }
                  class="spoiler-text-field"
                  lang={language}
                  spellCheck="true"
                  autocomplete="off"
                  dir="auto"
                  onInput={() => {
                    updateCharCount();
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      !e.ctrlKey &&
                      !e.metaKey &&
                      !e.isComposing
                    ) {
                      e.preventDefault();
                      focusTextarea();
                    }
                  }}
                />
              </TextExpander>
              <button
                type="button"
                class="close-button plain4 small"
                onClick={() => {
                  setSensitive(false);
                  textareaRef.current.focus();
                }}
              >
                <Icon icon="x" alt={t`Cancel`} />
              </button>
            </div>
            <div class="main-textarea-wrapper">
              <Textarea
                ref={textareaRef}
                data-allow-custom-emoji="true"
                placeholder={
                  replyToStatus
                    ? t`Post your reply`
                    : editStatus
                      ? t`Edit your post`
                      : !!poll
                        ? t`Ask a question`
                        : t`What are you doing?`
                }
                required={mediaAttachments?.length === 0}
                disabled={uiState === 'loading'}
                readOnly={!!threadPublishState}
                lang={language}
                onInput={() => {
                  updateCharCount();
                }}
                maxCharacters={effectiveMaxCharacters}
                onTrigger={(action) => {
                  if (action?.name === 'custom-emojis') {
                    setShowEmoji2Picker({
                      targetElement: lastFocusedEmojiFieldRef,
                      defaultSearchTerm: action?.defaultSearchTerm || null,
                    });
                  } else if (action?.name === 'mention') {
                    setShowMentionPicker({
                      defaultSearchTerm: action?.defaultSearchTerm || null,
                    });
                  } else if (
                    action?.name === 'auto-detect-language' &&
                    action?.languages
                  ) {
                    setAutoDetectedLanguages(action.languages);
                  } else if (action?.name === 'pasted-link' && action?.url) {
                    handlePastedLink(action.url);
                  }
                }}
              />
              {threadPublishState && (
                <div class="posted-chip">
                  ✓ <span>{t`Posted`}</span>
                </div>
              )}
            </div>
          </div>
          {mediaAttachments?.length > 0 && (
            <div class="media-attachments">
              {mediaAttachments.map((attachment, i) => {
                const { id, file } = attachment;
                const fileID = file?.size + file?.type + file?.name;
                return (
                  <MediaAttachment
                    key={id || fileID || i}
                    attachment={attachment}
                    disabled={uiState === 'loading' || !!threadPublishState}
                    lang={language}
                    supportedMimeTypes={supportedMimeTypes}
                    descriptionLimit={descriptionLimit}
                    onDescriptionChange={(value) => {
                      setMediaAttachments((attachments) => {
                        const newAttachments = [...attachments];
                        newAttachments[i] = {
                          ...newAttachments[i],
                          description: value,
                        };
                        return newAttachments;
                      });
                    }}
                    onRemove={() => {
                      setMediaAttachments((attachments) => {
                        return attachments.filter((_, j) => j !== i);
                      });
                    }}
                  />
                );
              })}
              <label class="media-sensitive">
                <input
                  name="sensitiveMedia"
                  type="checkbox"
                  checked={sensitiveMedia}
                  disabled={uiState === 'loading' || !!threadPublishState}
                  onChange={(e) => {
                    const sensitiveMedia = e.target.checked;
                    setSensitiveMedia(sensitiveMedia);
                  }}
                />{' '}
                <span>
                  <Trans>Mark media as sensitive</Trans>
                </span>{' '}
                <Icon icon={`eye-${sensitiveMedia ? 'close' : 'open'}`} />
              </label>
            </div>
          )}
          {moreSegments.map((segment, index) => {
            // Overall index: main editor = 0, moreSegments[i] = i + 1
            const overallIndex = index + 1;
            const isPosted =
              threadPublishState &&
              overallIndex < threadPublishState.postedStatuses.length;
            return (
              <ThreadSegmentEditor
                key={segment.uid}
                segment={segment}
                maxCharacters={effectiveMaxCharacters}
                blueskyRules={
                  charLimitBoundByBluesky ||
                  maxCharacters === BLUESKY_MAX_CHARACTERS
                }
                maxMediaAttachments={maxMediaAttachments}
                disabled={uiState === 'loading'}
                posted={isPosted}
                onChange={(patch) =>
                  setMoreSegments((segs) =>
                    segs.map((s) =>
                      s.uid === segment.uid ? { ...s, ...patch } : s,
                    ),
                  )
                }
                onRemove={() => {
                  setMoreSegments((segs) =>
                    segs.filter((s) => s.uid !== segment.uid),
                  );
                }}
                processFiles={processFiles}
                stringLength={stringLength}
              />
            );
          })}
          {!editStatus && moreSegments.length < MAX_THREAD_SEGMENTS - 1 && (
            <button
              type="button"
              class={`light add-thread-segment${
                replyToStatus ? ' subtle' : ''
              }`}
              disabled={uiState === 'loading' || !!scheduledAt}
              title={scheduledAt ? t`Threads can't be scheduled` : undefined}
              onClick={() => {
                setMoreSegments((segs) => [
                  ...segs,
                  { uid: uid(), text: '', mediaAttachments: [] },
                ]);
              }}
            >
              <Icon icon="plus" /> <Trans>Add to thread</Trans>
            </button>
          )}
          {!!poll && (
            <ComposePoll
              lang={language}
              maxOptions={maxOptions}
              maxExpiration={maxExpiration}
              minExpiration={minExpiration}
              maxCharactersPerOption={maxCharactersPerOption}
              poll={poll}
              disabled={uiState === 'loading'}
              onInput={(poll) => {
                if (poll) {
                  const newPoll = { ...poll };
                  setPoll(newPoll);
                } else {
                  setPoll(null);
                  focusLastFocusedField();
                }
              }}
            />
          )}
          {!!currentQuoteStatus?.id && (
            <div class="quote-status">
              <Status
                status={currentQuoteStatus}
                instance={instance}
                size="s"
                readOnly
              />
            </div>
          )}
          {scheduledAt && (
            <div class="toolbar scheduled-at">
              <span>
                <label>
                  <Trans>
                    Posting on{' '}
                    <ScheduledAtField
                      scheduledAt={scheduledAt}
                      setScheduledAt={setScheduledAt}
                    />
                  </Trans>
                </label>{' '}
                <small class="tag insignificant">
                  {getLocalTimezoneName()}
                </small>
              </span>
              <button
                type="button"
                class="plain4 close-button small"
                onClick={() => {
                  setScheduledAt(null);
                  focusLastFocusedField();
                }}
              >
                <Icon icon="x" alt={t`Cancel`} />
              </button>
            </div>
          )}
          <QuoteSuggestion
            quoteSuggestion={quoteSuggestion}
            hasCurrentQuoteStatus={!!currentQuoteStatus?.id}
            onAccept={() => {
              const { status } = quoteSuggestion;

              // Remove the pasted link from textarea
              const currentValue = textareaRef.current?.value || '';
              // Find pasted link nearest to last cursor position
              const lastCursorPos = textareaRef.current?.selectionStart || 0;
              const pastedLinkPos = currentValue.lastIndexOf(
                quoteSuggestion.url,
                lastCursorPos,
              );
              const newValue =
                currentValue.slice(0, pastedLinkPos) +
                currentValue.slice(pastedLinkPos + quoteSuggestion.url.length);
              if (textareaRef.current) {
                textareaRef.current.value = newValue;
                textareaRef.current.dispatchEvent(new Event('input'));
              }

              const hasCurrentQuote = !!currentQuoteStatus?.id;
              if (hasCurrentQuote) {
                // If there's already a quote, replacement doesn't need transition
                setQuoteSuggestion(null);
                setLocalQuoteStatus(status);
              } else {
                // Transition the unfurled quote to the quote preview
                if (document.startViewTransition) {
                  document.startViewTransition(() => {
                    setQuoteSuggestion(null);
                    setLocalQuoteStatus(status);
                  });
                } else {
                  setQuoteSuggestion(null);
                  setLocalQuoteStatus(status);
                }
              }
              focusTextarea();
            }}
            onCancel={() => setQuoteSuggestion(null)}
          />
          {targetRoster.length > 1 && (
            <div class="toolbar cross-post-toolbar">
              <AccountPickerCheckboxes
                accounts={targetRoster}
                selectedIDs={new Set(checkedTargets.map((a) => a.info.id))}
                disabled={uiState === 'loading' || !!threadPublishState}
                onToggle={(account, checked) => {
                  const next = new Set(uncheckedIDs);
                  if (checked) {
                    next.delete(account.info.id);
                  } else {
                    next.add(account.info.id);
                  }
                  setUncheckedIDs(next);
                  store.local.setJSON('composeUncheckedAccounts', [...next]);
                }}
              />
            </div>
          )}
          <div class="toolbar compose-footer">
            <span class="add-toolbar-button-group spacer">
              {showAddButton && (
                <Menu2
                  portal={{
                    target: document.body,
                  }}
                  containerProps={{
                    style: {
                      zIndex: 1001,
                    },
                  }}
                  menuButton={({ open }) => (
                    <button
                      type="button"
                      class={`toolbar-button add-button ${
                        open ? 'active' : ''
                      }`}
                    >
                      <Icon icon="plus" title={t`Add`} />
                    </button>
                  )}
                >
                  {supportsCameraCapture && (
                    <MenuItem
                      disabled={mediaButtonDisabled}
                      className="compose-menu-add-media"
                    >
                      <label class="compose-menu-add-media-field">
                        <CameraCaptureInput
                          hidden
                          supportedMimeTypes={supportedImagesVideosTypes}
                          disabled={mediaButtonDisabled}
                          setMediaAttachments={setMediaAttachments}
                        />
                      </label>
                      <Icon icon="camera" /> <span>{_(ADD_LABELS.camera)}</span>
                    </MenuItem>
                  )}
                  <MenuItem
                    disabled={mediaButtonDisabled}
                    className="compose-menu-add-media"
                  >
                    <label class="compose-menu-add-media-field">
                      <FilePickerInput
                        hidden
                        supportedMimeTypes={supportedMimeTypes}
                        maxMediaAttachments={maxMediaAttachments}
                        mediaAttachments={mediaAttachments}
                        disabled={mediaButtonDisabled}
                        setMediaAttachments={setMediaAttachments}
                      />
                    </label>
                    <Icon icon="media" /> <span>{_(ADD_LABELS.media)}</span>
                  </MenuItem>
                  <MenuItem
                    disabled={cwButtonDisabled}
                    onClick={onCWButtonClick}
                  >
                    <Icon icon="alert" /> <span>{_(ADD_LABELS.sensitive)}</span>
                  </MenuItem>
                  {showPollButton && (
                    <MenuItem
                      disabled={pollButtonDisabled}
                      onClick={onPollButtonClick}
                    >
                      <Icon icon="poll" /> <span>{_(ADD_LABELS.poll)}</span>
                    </MenuItem>
                  )}
                  <MenuDivider />
                  <MenuItem
                    onClick={() => {
                      setShowEmoji2Picker({
                        targetElement: lastFocusedEmojiFieldRef,
                      });
                    }}
                  >
                    <Icon icon="emoji2" />{' '}
                    <span>{_(ADD_LABELS.customEmoji)}</span>
                  </MenuItem>
                  {!!states.settings.composerGIFPicker && (
                    <MenuItem
                      disabled={mediaButtonDisabled}
                      onClick={() => {
                        setShowGIFPicker(true);
                      }}
                    >
                      <span class="icon icon-gif" role="img" />
                      <span>{_(ADD_LABELS.gif)}</span>
                    </MenuItem>
                  )}
                  {showScheduledAt && (
                    <>
                      <MenuDivider />
                      <MenuItem
                        disabled={scheduledAtButtonDisabled}
                        title={scheduledAtButtonTitle}
                        onClick={onScheduledAtClick}
                      >
                        <Icon icon="schedule" />{' '}
                        <span>{_(ADD_LABELS.scheduledPost)}</span>
                      </MenuItem>
                    </>
                  )}
                </Menu2>
              )}
              <span
                class="add-sub-toolbar-button-group"
                ref={addSubToolbarRef}
                hidden
              >
                {supportsCameraCapture && (
                  <label class="toolbar-button">
                    <CameraCaptureInput
                      supportedMimeTypes={supportedImagesVideosTypes}
                      mediaAttachments={mediaAttachments}
                      disabled={mediaButtonDisabled}
                      setMediaAttachments={setMediaAttachments}
                    />
                    <Icon icon="camera" alt={_(ADD_LABELS.camera)} />
                  </label>
                )}
                <label class="toolbar-button">
                  <FilePickerInput
                    supportedMimeTypes={supportedMimeTypes}
                    maxMediaAttachments={maxMediaAttachments}
                    mediaAttachments={mediaAttachments}
                    disabled={mediaButtonDisabled}
                    setMediaAttachments={setMediaAttachments}
                  />
                  <Icon icon="media" alt={_(ADD_LABELS.media)} />
                </label>
                <button
                  type="button"
                  class="toolbar-button"
                  disabled={cwButtonDisabled}
                  onClick={onCWButtonClick}
                >
                  <Icon icon="alert" alt={_(ADD_LABELS.sensitive)} />
                </button>
                {showPollButton && (
                  <button
                    type="button"
                    class="toolbar-button"
                    disabled={pollButtonDisabled}
                    onClick={onPollButtonClick}
                  >
                    <Icon icon="poll" alt={_(ADD_LABELS.poll)} />
                  </button>
                )}
                <div class="toolbar-divider" />
                {/* <button
                  type="button"
                  class="toolbar-button"
                  disabled={uiState === 'loading'}
                  onClick={() => {
                    setShowMentionPicker(true);
                  }}
                >
                  <Icon icon="at" />
                </button> */}
                <button
                  type="button"
                  class="toolbar-button"
                  disabled={uiState === 'loading'}
                  onClick={() => {
                    setShowEmoji2Picker({
                      targetElement: lastFocusedEmojiFieldRef,
                    });
                  }}
                >
                  <Icon icon="emoji2" alt={_(ADD_LABELS.customEmoji)} />
                </button>
                {!!states.settings.composerGIFPicker && (
                  <button
                    type="button"
                    class="toolbar-button gif-picker-button"
                    disabled={mediaButtonDisabled}
                    onClick={() => {
                      setShowGIFPicker(true);
                    }}
                  >
                    <span
                      class="icon icon-gif"
                      aria-label={_(ADD_LABELS.gif)}
                    />
                  </button>
                )}
                {showScheduledAt && (
                  <>
                    <div class="toolbar-divider" />
                    <button
                      type="button"
                      class={`toolbar-button ${scheduledAt ? 'highlight' : ''}`}
                      disabled={scheduledAtButtonDisabled}
                      title={scheduledAtButtonTitle}
                      onClick={onScheduledAtClick}
                    >
                      <Icon icon="schedule" alt={_(ADD_LABELS.scheduledPost)} />
                    </button>
                  </>
                )}
              </span>
            </span>
            {uiState === 'loading' ? (
              <Loader abrupt />
            ) : (
              <>
                <CharCountMeter
                  maxCharacters={effectiveMaxCharacters}
                  hidden={uiState === 'loading'}
                />
                {charLimitBoundByBluesky && (
                  <small
                    class="ib insignificant"
                    title={t`Bluesky limit applied: 300 characters`}
                  >
                    Bluesky
                  </small>
                )}
              </>
            )}
            {supportsNativeQuote(instance) && (
              <label
                class={`toolbar-button ${highlightQuoteApprovalPolicyField ? 'highlight' : ''}`}
              >
                <Icon icon="quote2" alt="Quote settings" />
                {quoteApprovalPolicy === 'followers' && (
                  <Icon icon="group" class="insignificant" />
                )}
                {quoteApprovalPolicy === 'nobody' && (
                  <Icon icon="block" class="insignificant" />
                )}
                <select
                  name="quoteApprovalPolicy"
                  value={quoteApprovalPolicy}
                  onChange={(e) => {
                    setQuoteApprovalPolicy(e.target.value);
                  }}
                  disabled={uiState === 'loading'}
                  dir="auto"
                >
                  <option value="public" disabled={disableQuotePolicy}>
                    <Trans>Anyone can quote</Trans>
                  </option>
                  <option value="followers" disabled={disableQuotePolicy}>
                    <Trans>Your followers can quote</Trans>
                  </option>
                  <option value="nobody">
                    <Trans>Only you can quote</Trans>
                  </option>
                </select>
              </label>
            )}
            <label
              class={`toolbar-button ${highlightVisibilityField ? 'highlight' : ''}`}
              title={_(visibilityText[visibility])}
            >
              {visibility === 'public' || visibility === 'direct' ? (
                <Icon
                  icon={visibilityIconsMap[visibility]}
                  alt={_(visibilityText[visibility])}
                />
              ) : (
                <span class="icon-text">{_(visibilityText[visibility])}</span>
              )}
              <select
                name="visibility"
                value={visibility}
                onChange={(e) => {
                  setVisibility(e.target.value);
                  if (
                    e.target.value === 'private' ||
                    e.target.value === 'direct'
                  ) {
                    setQuoteApprovalPolicy('nobody');
                  }

                  if (e.target.value === 'direct' && currentQuoteStatus?.id) {
                    const quoteURL = currentQuoteStatus.url;
                    if (quoteURL) {
                      const currentText = textareaRef.current.value;
                      if (!currentText.includes(quoteURL)) {
                        textareaRef.current.value =
                          currentText + (currentText ? '\n' : '') + quoteURL;
                        oninputTextarea();
                      }
                    }
                    setQuoteCleared(true);
                    showToast(t`Quotes can't be embedded in private mentions.`);
                  } else if (e.target.value !== 'direct' && quoteCleared) {
                    const quoteURL = (localQuoteStatus || quoteStatus)?.url;
                    if (quoteURL && textareaRef.current) {
                      const currentValue = textareaRef.current.value;
                      const linkPos = currentValue.indexOf(quoteURL);
                      if (linkPos !== -1) {
                        let newValue =
                          currentValue.slice(0, linkPos) +
                          currentValue.slice(linkPos + quoteURL.length);
                        newValue = newValue.replace(/\n+$/, '');
                        textareaRef.current.value = newValue;
                        oninputTextarea();
                      }
                    }
                    setQuoteCleared(false);
                  }
                }}
                disabled={
                  uiState === 'loading' || !!editStatus || !!threadPublishState
                }
                title={
                  threadPublishState
                    ? t`Locked while retrying a partially-posted thread`
                    : undefined
                }
                dir="auto"
              >
                <option value="public">
                  <Trans>Public</Trans>
                </option>
                {(supports('@pleroma/local-visibility-post') ||
                  supports('@akkoma/local-visibility-post')) && (
                  <option value="local">
                    <Trans>Local</Trans>
                  </option>
                )}
                <option value="unlisted">
                  <Trans>Quiet public</Trans>
                </option>
                <option value="private">
                  <Trans>Followers</Trans>
                </option>
                <option value="direct">
                  <Trans>Private mention</Trans>
                </option>
              </select>
            </label>{' '}
            <label
              class={`toolbar-button ${
                highlightLanguageField ? 'highlight' : ''
              }`}
            >
              <span class="icon-text">
                {supportedLanguagesMap[language]?.native || language}
              </span>
              <select
                name="language"
                value={language}
                onChange={(e) => {
                  const { value } = e.target;
                  setLanguage(value || DEFAULT_LANG);
                  store.session.set('currentLanguage', value || DEFAULT_LANG);
                }}
                disabled={uiState === 'loading' || !!threadPublishState}
                title={
                  threadPublishState
                    ? t`Locked while retrying a partially-posted thread`
                    : undefined
                }
                dir="auto"
              >
                {topSupportedLanguages.map(([code, common, native]) => {
                  const commonText = localeCode2Text({
                    code,
                    fallback: common,
                  });
                  const showCommon = commonText !== native;
                  return (
                    <option value={code} key={code}>
                      {showCommon ? `${native} - ${commonText}` : commonText}
                    </option>
                  );
                })}
                <hr />
                {restSupportedLanguages.map(([code, common, native]) => {
                  const commonText = localeCode2Text({
                    code,
                    fallback: common,
                  });
                  const showCommon = commonText !== native;
                  return (
                    <option value={code} key={code}>
                      {showCommon ? `${native} - ${commonText}` : commonText}
                    </option>
                  );
                })}
              </select>
            </label>{' '}
            <button
              type="submit"
              disabled={
                uiState === 'loading' ||
                (composeTargetable && checkedTargets.length === 0)
              }
              onClick={() => haptics.trigger('medium')}
              title={
                publishProgress ? t`Posting ${publishProgress}…` : undefined
              }
            >
              {threadPublishState
                ? t`Retry remaining`
                : scheduledAt
                  ? t`Schedule`
                  : replyToStatus
                    ? t`Reply`
                    : editStatus
                      ? t`Update`
                      : t({
                          message: 'Post',
                          context: 'Submit button in composer',
                        })}
              {uiState === 'loading' && publishProgress && (
                <>
                  {' '}
                  <span class="progress-text">{publishProgress}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
      {showMentionPicker && (
        <Modal
          onClose={() => {
            setShowMentionPicker(false);
            focusLastFocusedField();
          }}
        >
          <MentionModal
            masto={masto}
            instance={instance}
            onClose={() => {
              setShowMentionPicker(false);
            }}
            defaultSearchTerm={showMentionPicker?.defaultSearchTerm}
            onSelect={(socialAddress) => {
              const textarea = textareaRef.current;
              if (textarea) {
                insertTextAtCursor({
                  targetElement: textarea,
                  text: '@' + socialAddress,
                });
              }
            }}
          />
        </Modal>
      )}
      {showEmoji2Picker && (
        <Modal
          onClose={() => {
            setShowEmoji2Picker(false);
            focusLastFocusedField();
          }}
        >
          <CustomEmojisModal
            instance={instance}
            onClose={() => {
              setShowEmoji2Picker(false);
            }}
            defaultSearchTerm={showEmoji2Picker?.defaultSearchTerm}
            onSelect={(emojiShortcode) => {
              const targetElement =
                showEmoji2Picker?.targetElement?.current || textareaRef.current;
              if (targetElement) {
                insertTextAtCursor({ targetElement, text: emojiShortcode });
              }
            }}
          />
        </Modal>
      )}
      {showGIFPicker && (
        <Modal
          onClose={() => {
            setShowGIFPicker(false);
            focusLastFocusedField();
          }}
        >
          <GIFPickerModal
            onClose={() => setShowGIFPicker(false)}
            onSelect={({ url, type, alt_text }) => {
              console.log('GIF URL', url);
              if (mediaAttachments.length >= maxMediaAttachments) {
                alert(
                  plural(maxMediaAttachments, {
                    one: 'You can only attach up to 1 file.',
                    other: 'You can only attach up to # files.',
                  }),
                );
                return;
              }
              // Download the GIF and insert it as media attachment
              (async () => {
                let theToast;
                try {
                  theToast = showToast({
                    text: t`Downloading GIF…`,
                    duration: -1,
                  });
                  const blob = await fetch(url, {
                    referrerPolicy: 'no-referrer',
                  }).then((res) => res.blob());
                  const fileData = await blob.arrayBuffer();
                  const newMediaAttachments = [
                    ...mediaAttachments,
                    {
                      fileData,
                      fileName:
                        type === 'video/mp4' ? 'video.mp4' : 'image.gif',
                      type,
                      size: blob.size,
                      id: null,
                      description: alt_text || '',
                    },
                  ];
                  setMediaAttachments(newMediaAttachments);
                  theToast?.hideToast?.();
                } catch (err) {
                  console.error(err);
                  theToast?.hideToast?.();
                  showToast(t`Failed to download GIF`);
                }
              })();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function removeNullUndefined(obj) {
  for (let key in obj) {
    if (obj[key] === null || obj[key] === undefined) {
      delete obj[key];
    }
  }
  return obj;
}

export default Compose;
