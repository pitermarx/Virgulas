import { html, render } from 'htm/preact';
import { signal, computed } from '@preact/signals';
import { Outline } from '../components/outline.js';
import { StatusToolbar, MainToolbar } from '../components/toolbars.js';
import { ConflictModal } from '../components/conflictModal.js';
import { TasksPanel } from '../components/tasksPanel.js';
import { optionsOpen, tasksPanelOpen } from './shortcuts.js';
import persistence from './persistence.js';
import outline from './outline.js';
import { store } from './utils.js';
import inbox from './inbox.js';
import { encrypt, decrypt, randomId, generateSalt } from './crypto2.js';
import { pendingConflicts } from './syncEngine.js';
import { mergeDocuments } from './merge.js';
import {
  captureOnly,
  consumeQuickCaptureUrl,
  initCapture,
  quickCaptureOpen,
  QuickCapturePrompt,
  QuickCaptureToast,
  startCaptureIfRequested
} from './capture.js';
import { currentSearchMatchId, getFirstClosedParent } from './search.js';
import { noteSlotChars } from './quota.js';
import { startTodayTicker } from './tasks.js';
import { bindDialogFocus } from './dialogs.js';
import {
  LockScreen,
  SecureStoragePrompt,
  browserSupportWarning,
  initAuthState,
  isWizardOverlayOpen
} from './lockScreen.js';
import { OptionsModal } from './options.js';

// Splash lifecycle. `appReady` flips once the initial auth state and the
// webfont are ready; `splashDismissed` removes the node once its fade-out ends.
const appReady = signal(false);
const splashDismissed = signal(false);

// B4: Restore persisted theme preference on load
const savedTheme = store.theme.get();
if (savedTheme) {
  document.documentElement.setAttribute('data-theme', savedTheme);
}

// a11y-02: every dialog takes focus, keeps Tab inside when it is modal, and
// hands focus back to its opener. The conflict dialog is blocking, so it has no
// Escape path; the tasks panel is a region, not a modal, so it does not trap.
const conflictDialogOpen = computed(() => pendingConflicts.value.length > 0);
bindDialogFocus(conflictDialogOpen, { labelId: 'conflict-title' });
bindDialogFocus(tasksPanelOpen, { labelId: 'tasks-panel-title', trap: false });

function handOverToUnlockScreen() {
  captureOnly.value = false;
  render(html`<${Splash} />`, document.getElementById('app')!);
  startAuthBootstrap({ forceLockScreen: true });
}
initCapture(handOverToUnlockScreen);

/**
 * Auth bootstrap for a normal visit or the post-confirmation handover. Kept
 * separate from rendering because the cold-boot call site runs before `Splash`
 * is initialised, and it must not prompt for WebAuthn during a capture visit.
 */
function startAuthBootstrap(options: { forceLockScreen?: boolean } = {}) {
  void (async () => {
    try {
      startTodayTicker();
      await initAuthState(options);
    } catch (error) {
      console.error('Failed to initialise app state', error);
    } finally {
      appReady.value = true;
      scheduleSplashDismissal();
    }
  })();
}

/**
 * Capture-only boot: ask for confirmation, then write nothing yet. The pending
 * intent is held so the share-target description survives into the queue entry.
 */
// Fallback when the splash's computed transition can't be read. Mirrors
// `--splash-fade` in base.css.
const DEFAULT_SPLASH_FADE_MS = 700;
// Grace on top of the fade so `transitionend` normally wins the race.
const SPLASH_FADE_GRACE_MS = 400;

let splashFallbackTimer: ReturnType<typeof setTimeout> | null = null;

function splashFadeMs(): number {
  if (typeof document === 'undefined') return DEFAULT_SPLASH_FADE_MS;
  const element = document.getElementById('splash');
  if (!element) return DEFAULT_SPLASH_FADE_MS;
  const styles = window.getComputedStyle(element);
  // The splash declares more than one transition (the fade, and the visibility
  // step that ends with it), so the node is only gone when the *last* of them
  // has finished: take the longest duration + delay pair rather than the first.
  const durations = styles.transitionDuration.split(',').map(value => parseFloat(value) || 0);
  const delays = styles.transitionDelay.split(',').map(value => parseFloat(value) || 0);
  const seconds = Math.max(0, ...durations.map((duration, index) => duration + (delays[index] ?? 0)));
  return seconds > 0 ? seconds * 1000 : DEFAULT_SPLASH_FADE_MS;
}

/**
 * Arm the splash removal for the fade that is about to run.
 *
 * Called when the app becomes ready, so a browser that never starts or never
 * reports the fade still drops the node, and again from the splash's first
 * `transitionrun`. The second call is what makes the deadline correct:
 * `appReady` flips before Preact re-renders and the browser recalculates style,
 * so on a busy main thread the fade can start hundreds of milliseconds later,
 * and a timer armed at readiness would remove the node while it is still
 * fading — removing a transitioning node at that instant also swallows the
 * transition's own `transitionend`. Re-arming restarts the fade + grace window
 * from the frame the fade actually starts.
 *
 * This deliberately runs outside a component effect. The removal is the
 * readiness gate the user (and the e2e suite) waits on, so it must not depend
 * on a Preact effect flush: effects are queued behind an animation frame and
 * are superseded when a re-render happens first, which is how a WebKit shard
 * kept `<div id="splash" class="hidden">` mounted for a whole 5 s assertion
 * window. Module-level state survives every re-render, so this one timer covers
 * the lifetime of the component. `#splash.hidden` also leaves the visible tree
 * at the end of the fade (base.css), so the app never waits on this callback to
 * become visible or usable.
 */
function scheduleSplashDismissal() {
  if (splashDismissed.value) return;
  if (splashFallbackTimer !== null) clearTimeout(splashFallbackTimer);
  splashFallbackTimer = setTimeout(dismissSplash, splashFadeMs() + SPLASH_FADE_GRACE_MS);
}

function dismissSplash() {
  if (splashFallbackTimer !== null) {
    clearTimeout(splashFallbackTimer);
    splashFallbackTimer = null;
  }
  splashDismissed.value = true;
}

// A capture visit must not boot the app: no auth bootstrap, no key derivation,
// no decryption, no biometric prompt. It renders the confirmation prompt only,
// and `handOverToUnlockScreen` runs the boot once the user confirms (sec-01).
//
// The splash is a readiness gate for the *app*, not for the webfont: awaiting
// `document.fonts.ready` cost ~23ms of time-to-reveal, so the reveal no longer
// blocks on it and the webfont swaps in underneath the splash fade instead.
if (!captureOnly.value) {
  startAuthBootstrap();
  consumeQuickCaptureUrl();
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', consumeQuickCaptureUrl);
    window.addEventListener('popstate', consumeQuickCaptureUrl);
  }
}
const Splash = () => {
  const ready = appReady.value;
  let isLocked = false;

  // `transitionend` is the normal path to removal; `scheduleSplashDismissal`
  // is the safety net. It is armed when `appReady` flips (see
  // startAuthBootstrap) and re-armed on the fade's first frame below.

  if (ready) {
    isLocked = persistence.isLocked();

    if (isLocked) {
      document.body.removeAttribute('data-main-view');
    } else {
      document.body.setAttribute('data-main-view', 'rendered');
    }
  }

  return html`
    ${!splashDismissed.value && html`
      <div
        id="splash"
        class=${ready ? 'hidden' : ''}
        onTransitionRun=${(event: TransitionEvent) => {
        // The fade's first frame: measure the removal deadline from here, not
        // from the moment `appReady` flipped (scheduleSplashDismissal).
        if (event.propertyName === 'opacity' && event.target === event.currentTarget) scheduleSplashDismissal();
      }}
        onTransitionEnd=${(event: TransitionEvent) => {
        if (event.propertyName === 'opacity' && event.target === event.currentTarget) dismissSplash();
      }}
      >
        <div class="logo">Virgulas</div>
        <div class="tagline">Local-first browser outliner</div>
      </div>`}

    ${ready && html`
    <div class="app-shell">
      <div class=${`main-view ${isLocked || isWizardOverlayOpen() ? 'is-locked' : ''}`}>
        <main class="main-content" id="main-content" tabindex="-1"
          inert=${optionsOpen.value || quickCaptureOpen.value || pendingConflicts.value.length > 0 || undefined}>
          <${MainToolbar} banner=${html`
            ${!isLocked && browserSupportWarning.value && html`<div class="form-error" role="alert">${browserSupportWarning.value}</div>`}
            ${!isLocked && persistence.getMode() === 'local' && persistence.localStoragePersistenceNotice.value && html`
              <div class="storage-persistence-notice" role="status">
                <p>Browser storage is best-effort and may be cleared automatically. Export a backup periodically, or use File or Remote storage.</p>
                <button type="button" class="toolbar-btn" aria-label="Dismiss storage reminder" title="Dismiss storage reminder"
                  onClick=${persistence.dismissLocalStoragePersistenceNotice}>×</button>
              </div>
            `}
            ${!isLocked && (persistence.getMode() === 'local' || persistence.getMode() === 'remote')
              && persistence.slotQuotaNotice.value !== 'ok' && html`
              <div class="storage-persistence-notice" role=${persistence.slotQuotaNotice.value === 'full' ? 'alert' : 'status'}>
                <p>${persistence.slotQuotaNotice.value === 'full'
                  ? 'This document has reached its storage budget. Trim it \u2014 export a backup first \u2014 or move it to File storage.'
                  : 'This document is getting large for its storage budget. Trim it, or move it to File storage to keep growing.'}</p>
                <button type="button" class="toolbar-btn" aria-label="Dismiss size reminder" title="Dismiss size reminder"
                  onClick=${persistence.dismissSlotQuotaNotice}>×</button>
              </div>
            `}
            <${SecureStoragePrompt} />
          `} />
          <${Outline} />
        </main>
        <${StatusToolbar} />
        ${!isLocked && html`<${OptionsModal} />`}
        ${!isLocked && html`<${ConflictModal} />`}
        ${!isLocked && html`<${TasksPanel} />`}
      </div>
      ${(isLocked || isWizardOverlayOpen()) && html`<${LockScreen} />`}
      <${QuickCapturePrompt} />
      <${QuickCaptureToast} />
    </div>
    `}
  `;
};

if (!startCaptureIfRequested()) {
  render(html`<${Splash} />`, document.getElementById('app')!);
}

// Runtime mouse detection. CSS `any-hover` is unreliable on hybrid devices — a
// Surface can report no hover-capable pointer even with a mouse attached — so
// the first real mouse move marks the shell as a pointer/mouse environment and
// the collapse arrows switch to their hover-only behaviour (see outline.css).
if (typeof window !== 'undefined') {
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    document.body?.classList.add('detected-pointer-mouse');
    window.removeEventListener('pointermove', onPointerMove);
  };
  window.addEventListener('pointermove', onPointerMove);
}

// Skip link: move focus to the main landmark without changing the URL hash. The
// app uses `location.hash` for zoom routing, so navigating to `#main-content`
// would be read as a node id, re-render the outline, and drop the focus.
if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (!target?.closest?.('.skip-link')) return;
    const main = document.getElementById('main-content');
    if (!main) return;
    event.preventDefault();
    main.focus();
    main.scrollIntoView({ block: 'start' });
  });
}

// Register the service worker from the bundle so index.html needs no inline script
// (the page ships a strict script-src CSP without 'unsafe-inline').
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext && !navigator.webdriver) {
  window.addEventListener('load', () => {
    const swUrl = new URL('./sw.js', window.location.href);
    navigator.serviceWorker.register(swUrl).catch((error) => {
      console.warn('Service worker registration failed', error);
    });
  });
}

// ── E2E introspection seam (sec-05) ──────────────────────────────────────────
//
// Specs import app singletons from the built bundle so they observe the same
// module instances the running app uses. The binding is populated only when
// `__TEST_HOOKS__` is compiled in (the Playwright bundle); in production it is
// a compile-time false, so the object stays empty and no same-origin script —
// the SRI-pinned tracker included — can reach the singletons or a passphrase.
export interface E2EExports {
  outline: typeof outline
  persistence: typeof persistence
  inbox: typeof inbox
  encrypt: typeof encrypt
  decrypt: typeof decrypt
  randomId: typeof randomId
  generateSalt: typeof generateSalt
  pendingConflicts: typeof pendingConflicts
  mergeDocuments: typeof mergeDocuments
  currentSearchMatchId: typeof currentSearchMatchId
  getFirstClosedParent: typeof getFirstClosedParent
  noteSlotChars: typeof noteSlotChars
}

const e2eExports: E2EExports = typeof __TEST_HOOKS__ !== 'undefined' && __TEST_HOOKS__
  ? {
    outline,
    persistence,
    inbox,
    encrypt,
    decrypt,
    randomId,
    generateSalt,
    pendingConflicts,
    mergeDocuments,
    currentSearchMatchId,
    getFirstClosedParent,
    noteSlotChars,
  }
  : {} as E2EExports;

export { e2eExports as e2e };

// Styles are bundled by Bun. Modules may import their own CSS alongside this
// entry; all imports are concatenated (in order) into dist/js/app.css.
import '../css/base.css'
import '../css/controls.css'
import '../css/shell.css'
import '../css/outline.css'
import '../css/markdown.css'
import '../css/account.css'
import '../css/views.css'
import '../css/tasks.css'
