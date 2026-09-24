import { html, render } from 'htm/preact';
import { useEffect } from 'preact/hooks';
import { signal, effect } from '@preact/signals';
import { Outline, StatusToolbar, MainToolbar, optionsOpen, ConflictModal, TasksPanel } from "./ui.js";
import persistence, { type PersistenceMode } from './persistence.js';
import { biometrics } from './biometrics.js';
import { remoteSync } from './sync.js';
import outline from './outline.js';
import { appVersion, store } from './utils.js';
import { DEFAULT_ITERATIONS } from './crypto2.js';
import inbox, { type CaptureIntent } from './inbox.js';

// Splash lifecycle. `appReady` flips once the initial auth state and the
// webfont are ready; `splashDismissed` removes the node once its fade-out ends.
const appReady = signal(false);
const splashDismissed = signal(false);

// B4: Restore persisted theme preference on load
const savedTheme = store.theme.get();
if (savedTheme) {
  document.documentElement.setAttribute('data-theme', savedTheme);
}

const authMode = signal<PersistenceMode>('local');
const authScenario = signal('empty-local');
const authHasLocalData = signal(false);
const authHasSupabase = signal(false);
const authHasFilesystem = signal(false);
const username = signal('');
const password = signal('');
const passphrase = signal('');
const unlockError = signal('');
const unlockMessage = signal('');
const canResetRemoteData = signal(false);
const canResetLocalData = signal(false);
const isBusy = signal(false);
const authUser = signal<any>(null);
const authStep = signal('unlock');
// Remote unlock staging: when true, email+password were collected and we await the passphrase
const remotePasswordStage = signal(false);

// ── Account / options modal state ────────────────────────────────────────────
const bioEnrolled = signal(false);
const autoBioAttempted = signal(false);
const accountInfo = signal({ email: '', mode: '', encryptedBytes: 0 });
const adminBusy = signal(false);
const adminError = signal('');
const adminMessage = signal('');
const newEmail = signal('');
const newPassword = signal('');
const newPassphrase = signal('');
const editingOption = signal<'email' | 'password' | 'passphrase' | null>(null);
const inboxNodeName = signal(inbox.getNodeName());
const quickCaptureOpen = signal(false);
const quickCaptureText = signal('');
const quickCaptureNotice = signal('');
// null while the capture prompt is open; true/false once a capture was attempted.
const captureSaved = signal<boolean | null>(null);
const bookmarkletCopied = signal(false);
let quickCaptureNoticeTimer: ReturnType<typeof setTimeout> | null = null;
let bookmarkletCopiedTimer: ReturnType<typeof setTimeout> | null = null;

function announceQuickCapture(message: string) {
  quickCaptureNotice.value = message;
  if (quickCaptureNoticeTimer !== null) {
    clearTimeout(quickCaptureNoticeTimer);
  }
  quickCaptureNoticeTimer = setTimeout(() => {
    quickCaptureNotice.value = '';
    quickCaptureNoticeTimer = null;
  }, 5000);
}

function reconcileInbox() {
  if (persistence.isLocked() || persistence.isMemory()) return 0;
  const imported = inbox.reconcile();
  if (imported > 0) {
    announceQuickCapture(`Added ${imported} item${imported === 1 ? '' : 's'} to ${inbox.getNodeName()}.`);
  }
  return imported;
}

function enqueueIncomingCapture(text: string, description = '') {
  if (!inbox.enqueue(text, description)) {
    announceQuickCapture('Quick capture could not be saved on this device.');
    return false;
  }

  const imported = reconcileInbox();
  if (imported === 0) {
    announceQuickCapture(
      persistence.isLocked() || persistence.isMemory()
        ? `Saved to the ${inbox.getNodeName()} queue. Unlock secure storage to file it.`
        : `Saved to the ${inbox.getNodeName()} queue.`
    );
  }
  return true;
}

function closeQuickCapture() {
  quickCaptureOpen.value = false;
  quickCaptureText.value = '';
}

function submitQuickCapture(e: any) {
  e.preventDefault();
  if (!quickCaptureText.value.trim()) {
    announceQuickCapture('Enter some text before adding it.');
    return;
  }

  if (captureOnly) {
    // Capture-only visit: write the queue and leave. The document is never
    // loaded, so there is nothing to reconcile into here.
    if (!inbox.enqueue(quickCaptureText.value)) {
      announceQuickCapture('Quick capture could not be saved on this device.');
      return;
    }
    captureSaved.value = true;
    closeQuickCapture();
    closeCaptureWindow();
    return;
  }

  if (enqueueIncomingCapture(quickCaptureText.value)) {
    closeQuickCapture();
  }
}

/** Remove the capture parameters so a reload or re-share does not queue twice. */
function stripCaptureParams() {
  const url = new URL(window.location.href);
  ['quick-add', 'quick-capture', ...inbox.SHARE_TARGET_KEYS].forEach(key => url.searchParams.delete(key));
  const cleanUrl = `${url.pathname}${url.search ? `?${url.searchParams.toString()}` : ''}${url.hash}`;
  window.history.replaceState(null, '', cleanUrl || '/');
}

/**
 * Handle capture URLs that arrive while the app is already running (a share
 * target re-entry, or a history navigation). Cold loads never reach here: they
 * are handled by the capture fast-path before the app boots.
 */
function consumeQuickCaptureUrl() {
  if (typeof window === 'undefined') return;

  const intent = inbox.parseCaptureUrl(new URL(window.location.href));
  if (!intent) return;

  if (intent.kind === 'direct') enqueueIncomingCapture(intent.text, intent.description);
  else quickCaptureOpen.value = true;

  stripCaptureParams();
}

// Decide the capture fast-path before anything boots. Only a script-opened
// window (the bookmarklet popup) may close itself; elsewhere `window.close()`
// is ignored and the confirmation card stays on screen.
const initialCaptureIntent = typeof window === 'undefined'
  ? null
  : inbox.parseCaptureUrl(new URL(window.location.href));
const captureOnly = initialCaptureIntent !== null;

function closeCaptureWindow() {
  try {
    window.close();
  } catch {
    /* Closing the window is best-effort. */
  }
}

/**
 * Capture-only boot: queue the text (or ask for it) and render a minimal
 * surface. Deliberately skips auth bootstrap, decryption and biometric unlock.
 */
function startCaptureOnly(intent: CaptureIntent) {
  if (intent.kind === 'direct') {
    captureSaved.value = inbox.enqueue(intent.text, intent.description);
  } else {
    quickCaptureOpen.value = true;
  }

  stripCaptureParams();
  render(html`<${CaptureSurface} />`, document.getElementById('app')!);

  if (intent.kind === 'direct' && captureSaved.value) closeCaptureWindow();
}

function captureAppUrl() {
  if (typeof window === 'undefined') return '/';
  return `${window.location.origin}${window.location.pathname}`;
}

const bookmarkletHref = inbox.buildBookmarklet(captureAppUrl());

// The bookmarklet is a single control: clicking copies its source so it can be
// pasted into a bookmark, while dragging (native anchor drag) installs it.
async function handleBookmarkletClick(event: any) {
  event.preventDefault();
  try {
    await navigator.clipboard.writeText(bookmarkletHref);
    bookmarkletCopied.value = true;
    if (bookmarkletCopiedTimer !== null) clearTimeout(bookmarkletCopiedTimer);
    bookmarkletCopiedTimer = setTimeout(() => {
      bookmarkletCopied.value = false;
      bookmarkletCopiedTimer = null;
    }, 3000);
  } catch {
    adminError.value = 'Could not copy the bookmarklet. Drag it onto your bookmarks bar instead.';
  }
}

// Reconcile a queue that was captured while the app was locked as soon as a
// persisted document becomes available. Memory mode deliberately leaves the
// queue untouched for a later secure-storage unlock.
effect(() => {
  const locked = persistence.isLocked();
  const mode = persistence.getMode();
  if (locked || mode === 'memory') return;
  reconcileInbox();
});

async function refreshAccountInfo() {
  let user: any = null;
  try { user = await persistence.getUser(); } catch { /* ignore */ }
  accountInfo.value = {
    email: user?.email || '',
    mode: persistence.getMode(),
    encryptedBytes: (store.data.get('') || '').length
  };
}

effect(() => {
  if (optionsOpen.value) {
    editingOption.value = null;
    void refreshAccountInfo();
    void biometrics.hasEnrolled().then(v => { bioEnrolled.value = v });
  }
});

if (typeof window !== 'undefined' && biometrics.isSupported()) {
  biometrics.hasEnrolled().then(v => { bioEnrolled.value = v });
}

async function runAdminAction(action: () => Promise<unknown>, successMessage: string) {
  adminError.value = '';
  adminMessage.value = '';
  adminBusy.value = true;
  try {
    await action();
    adminMessage.value = successMessage;
    await refreshAccountInfo();
  } catch (error) {
    adminError.value = String((error as { message?: string } | null)?.message || 'Something went wrong.');
  } finally {
    adminBusy.value = false;
  }
}

function submitChangeEmail(e: any) {
  e.preventDefault();
  if (!newEmail.value.trim()) {
    adminError.value = 'Email cannot be empty.';
    return;
  }
  const next = newEmail.value.trim();
  newEmail.value = '';
  editingOption.value = null;
  void runAdminAction(() => remoteSync.updateEmail(next), 'Email updated. Confirm the change from the new address if required.');
}

function submitChangePassword(e: any) {
  e.preventDefault();
  if (!newPassword.value) {
    adminError.value = 'Password cannot be empty.';
    return;
  }
  const next = newPassword.value;
  newPassword.value = '';
  editingOption.value = null;
  void runAdminAction(() => remoteSync.updatePassword(next), 'Account password updated.');
}

function submitChangePassphrase(e: any) {
  e.preventDefault();
  if (!newPassphrase.value) {
    adminError.value = 'New passphrase cannot be empty.';
    return;
  }
  const next = newPassphrase.value;
  newPassphrase.value = '';
  editingOption.value = null;
  void runAdminAction(() => persistence.changePassphrase(next), 'Encryption passphrase changed. Data was re-encrypted.');
}

function enrollBiometric() {
  void runAdminAction(async () => {
    const pass = persistence.getPassphrase();
    if (!pass) throw new Error('Unlock with a passphrase before enabling biometric unlock.');
    await biometrics.enroll(pass, accountInfo.value.email || 'Virgulas user');
    bioEnrolled.value = true;
  }, 'Biometric unlock enabled on this device.');
}

function forgetBiometric() {
  void biometrics.forget()
    .then(() => {
      bioEnrolled.value = false;
      adminMessage.value = 'This device can no longer unlock with biometrics.';
    })
    .catch(err => {
      adminError.value = String((err as { message?: string } | null)?.message || 'Failed to remove biometric unlock.');
    });
}

function exportDoc() {
  try {
    const vmd = persistence.exportVmd();
    const blob = new Blob([vmd], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `virgulas-${stamp}.vmd`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    adminMessage.value = 'Exported .vmd backup.';
  } catch (error) {
    adminError.value = String((error as { message?: string } | null)?.message || 'Export failed.');
  }
}

async function importDoc(e: any) {
  const file = e.target?.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    persistence.importVmd(text);
    adminMessage.value = 'Imported document. It will be re-encrypted and saved.';
  } catch (error) {
    adminError.value = String((error as { message?: string } | null)?.message || 'Import failed.');
  }
}

function handleInboxNodeNameChange(e: any) {
  inboxNodeName.value = inbox.setNodeName(e.currentTarget.value);
}

const isRemoteSessionValid = () => authMode.value === 'remote' && authScenario.value === 'remote-session-valid' && !!authUser.value;
const isLocalCreate = () => authMode.value === 'local' && !authHasLocalData.value;

let stagedMemoryDocJson: string | null = null;
let cachedIntroText: string | null = null;

async function getIntroText() {
  if (cachedIntroText !== null) return cachedIntroText;
  try {
    const resp = await fetch('/intro.vmd');
    cachedIntroText = resp.ok ? await resp.text() : '';
  } catch {
    cachedIntroText = '';
  }
  return cachedIntroText;
}

async function loadLockedBackgroundIntro() {
  const introText = await getIntroText();
  outline.reset();
  if (introText && introText.trim()) {
    outline.setRootVMD(introText);
  } else {
    outline.addChild('root', { text: '' });
  }
}

async function initAuthState() {
  const bootstrap = await persistence.getAuthBootstrap();
  authMode.value = bootstrap.mode as PersistenceMode;
  authScenario.value = bootstrap.scenario;
  authHasLocalData.value = bootstrap.hasLocalData;
  authHasSupabase.value = bootstrap.hasSupabase;
  authHasFilesystem.value = bootstrap.hasFilesystem || false;
  username.value = bootstrap.lastUsername || '';
  authUser.value = bootstrap.user || null;

  // Memory mode: skip the lock screen entirely
  if (bootstrap.mode === 'memory') {
    await persistence.unlock('', { mode: 'memory' });
    document.body.setAttribute('data-main-view', 'rendered');
    return;
  }

  if (persistence.isLocked()) {
    await loadLockedBackgroundIntro();
  }
}

// Fallback when the splash's computed transition can't be read.
const DEFAULT_SPLASH_FADE_MS = 700;

let splashFallbackTimer: ReturnType<typeof setTimeout> | null = null;

function dismissSplash() {
  if (splashFallbackTimer !== null) {
    clearTimeout(splashFallbackTimer);
    splashFallbackTimer = null;
  }
  splashDismissed.value = true;
}

// A capture visit must not boot the app: no auth bootstrap, no key derivation,
// no decryption, no biometric prompt. `startCaptureOnly` performs the queue
// write instead, at the tail of this module.
//
// The splash is a readiness gate for the *app*, not for the webfont: awaiting
// `document.fonts.ready` cost ~23ms of time-to-reveal, so the reveal no longer
// blocks on it and the webfont swaps in underneath the splash fade instead.
if (!captureOnly) {
  void (async () => {
    try {
      await initAuthState();
    } catch (error) {
      console.error('Failed to initialise app state', error);
    } finally {
      appReady.value = true;
    }
  })();
}

async function requestChangeMode() {
  if (authMode.value === 'local' && authHasLocalData.value) {
    if (!confirm('Switching mode will clear your local encrypted data from this device. Continue?')) return;
    persistence.clearLocalData();
    authHasLocalData.value = false;
  } else if (authMode.value === 'remote' && authUser.value) {
    if (!confirm('Switching mode will sign you out of the remote session. Continue?')) return;
    await persistence.signOut();
    authUser.value = null;
  }
  authStep.value = 'choose-mode';
  unlockError.value = '';
  unlockMessage.value = '';
  canResetRemoteData.value = false;
  canResetLocalData.value = false;
  passphrase.value = '';
  password.value = '';
  remotePasswordStage.value = false;
  autoBioAttempted.value = false;
}

function pickMode(nextMode: PersistenceMode) {
  if (nextMode === 'filesystem' && !persistence.hasFilesystem()) {
    unlockError.value = 'File System Access API is not supported in this browser.';
    return;
  }
  authMode.value = nextMode;
  authScenario.value = nextMode === 'local'
    ? (authHasLocalData.value ? 'local-present-no-session' : 'empty-local')
    : nextMode === 'filesystem'
      ? 'filesystem-ready'
      : 'remote-session-expired';
  persistence.setPreferredMode(nextMode);
  unlockError.value = '';
  canResetRemoteData.value = false;
  canResetLocalData.value = false;
  passphrase.value = '';
  remotePasswordStage.value = false;
  password.value = '';
  authStep.value = 'unlock';
  autoBioAttempted.value = false;
}

async function submitUnlock(e: any) {
  e.preventDefault();
  if (isBusy.value) return;
  unlockError.value = '';
  unlockMessage.value = '';
  canResetRemoteData.value = false;
  canResetLocalData.value = false;
  isBusy.value = true;
  try {
    if (authMode.value === 'filesystem') {
      await persistence.unlock('', { mode: 'filesystem' });
      stagedMemoryDocJson = null;
      document.body.setAttribute('data-main-view', 'rendered');
      return;
    }

    if (!passphrase.value.trim()) {
      unlockError.value = 'Passphrase cannot be empty.';
      return;
    }

    if (authMode.value === 'remote' && !authHasSupabase.value) {
      unlockError.value = 'Remote mode is unavailable because sync is not configured.';
      return;
    }

    const success = await persistence.unlock(passphrase.value, {
      mode: authMode.value,
      username: username.value,
      password: password.value,
      trustSession: isRemoteSessionValid()
    });
    if (success) {
      remotePasswordStage.value = false;
      if (authMode.value === 'remote') {
        authUser.value = await persistence.getUser();
      }
      stagedMemoryDocJson = null;
      document.body.setAttribute('data-main-view', 'rendered');
    } else {
      unlockError.value = 'Invalid passphrase.';
      canResetLocalData.value = authMode.value === 'local' && authHasLocalData.value;
    }
  } catch (error) {
    const message = String((error as { message?: string } | null)?.message || 'Failed to unlock.');
    unlockError.value = message;
    canResetRemoteData.value = authMode.value === 'remote' && message.includes('Authenticated, but data could not be decrypted');
  } finally {
    isBusy.value = false;
  }
}

async function submitSignUp() {
  unlockError.value = '';
  unlockMessage.value = '';
  if (!username.value.trim() || !password.value) {
    unlockError.value = 'Username and password are required.';
    return;
  }
  isBusy.value = true;
  try {
    const result = await persistence.signUp(username.value, password.value);
    authUser.value = await persistence.getUser();
    if (authUser.value) {
      authScenario.value = 'remote-session-valid';
      remotePasswordStage.value = false;
    }
    if (!result?.user) {
      unlockMessage.value = 'Sign-up submitted. Confirm your email if confirmation is enabled.';
    }
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Failed to sign up.');
  } finally {
    isBusy.value = false;
  }
}

async function submitSignOut() {
  unlockError.value = '';
  unlockMessage.value = '';
  isBusy.value = true;
  try {
    await persistence.signOut();
    authUser.value = null;
    remotePasswordStage.value = false;
    await persistence.unlock('', { mode: 'memory' });
    persistence.setPreferredMode('memory');
    stagedMemoryDocJson = null;
    document.body.setAttribute('data-main-view', 'rendered');
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Failed to sign out.');
  } finally {
    isBusy.value = false;
  }
}

async function submitResetLocalData() {
  unlockError.value = '';
  unlockMessage.value = '';
  if (!passphrase.value.trim()) {
    unlockError.value = 'Enter a new passphrase before resetting local data.';
    return;
  }
  const confirmed = confirm('This replaces your local encrypted data with a new empty document. Continue?');
  if (!confirmed) return;

  isBusy.value = true;
  try {
    persistence.clearLocalData();
    authHasLocalData.value = false;
    canResetLocalData.value = false;
    const success = await persistence.unlock(passphrase.value, { mode: 'local' });
    if (success) {
      stagedMemoryDocJson = null;
      document.body.setAttribute('data-main-view', 'rendered');
    } else {
      unlockError.value = 'Failed to create new local data.';
    }
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Failed to reset local data.');
  } finally {
    isBusy.value = false;
  }
}

async function submitResetRemoteData() {
  unlockError.value = '';
  unlockMessage.value = '';
  if (!passphrase.value.trim()) {
    unlockError.value = 'Enter a new passphrase before resetting remote data.';
    return;
  }
  const confirmed = confirm('This replaces your remote encrypted data with a new empty document. Continue?');
  if (!confirmed) return;

  isBusy.value = true;
  try {
    await persistence.resetRemoteData(passphrase.value, {
      username: username.value,
      password: password.value
    });
    canResetRemoteData.value = false;
    document.body.setAttribute('data-main-view', 'rendered');
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Failed to reset remote data.');
  } finally {
    isBusy.value = false;
  }
}

async function continueInMemory() {
  const staged = stagedMemoryDocJson;
  stagedMemoryDocJson = null;
  await persistence.unlock('', { mode: 'memory' });
  persistence.setPreferredMode('memory');
  if (staged) {
    outline.deserialize(staged);
  }
  document.body.setAttribute('data-main-view', 'rendered');
}

function openSecureStorageSetup() {
  stagedMemoryDocJson = outline.serialize();
  persistence.lock();
  authMode.value = 'local';
  authScenario.value = authHasLocalData.value ? 'local-present-no-session' : 'empty-local';
  authStep.value = 'unlock';
  autoBioAttempted.value = false;
  unlockError.value = '';
  unlockMessage.value = '';
  canResetRemoteData.value = false;
  canResetLocalData.value = false;
  password.value = '';
  passphrase.value = '';
  document.body.removeAttribute('data-main-view');
}

async function submitRemotePassword(e: any) {
  e.preventDefault();
  if (isBusy.value) return;
  if (!username.value.trim() || !password.value) {
    unlockError.value = 'Email and password are required.';
    return;
  }
  unlockError.value = '';
  unlockMessage.value = '';
  isBusy.value = true;
  try {
    // Authenticate the account now so invalid credentials surface at this step,
    // instead of only after the user has already entered their encryption passphrase.
    await remoteSync.signIn(username.value.trim(), password.value);
    authUser.value = await persistence.getUser();
    if (!authUser.value) {
      unlockError.value = 'Sign-in failed. Check your email and password.';
      return;
    }
    store.user.set(username.value.trim());
    remotePasswordStage.value = true;
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Sign-in failed. Check your email and password.');
  } finally {
    isBusy.value = false;
  }
}

async function unlockWithBiometrics() {
  if (isBusy.value) return;
  isBusy.value = true;
  unlockError.value = '';
  try {
    const recovered = await biometrics.unlock();
    if (!recovered) {
      unlockError.value = 'Biometric unlock failed. Enter your passphrase instead.';
      return;
    }
    passphrase.value = recovered;
    const success = await persistence.unlock(recovered, {
      mode: authMode.value,
      username: username.value,
      password: password.value,
      trustSession: isRemoteSessionValid()
    });
    if (success) {
      remotePasswordStage.value = false;
      if (authMode.value === 'remote') {
        authUser.value = await persistence.getUser();
      }
      stagedMemoryDocJson = null;
      document.body.setAttribute('data-main-view', 'rendered');
    } else {
      unlockError.value = 'Invalid passphrase.';
    }
  } catch (error) {
    unlockError.value = String((error as { message?: string } | null)?.message || 'Biometric unlock failed.');
  } finally {
    isBusy.value = false;
  }
}

effect(() => {
  // Capture-only visits stay locked on purpose and must not prompt for WebAuthn.
  if (captureOnly) return;

  const isLocked = persistence.isLocked();
  if (!isLocked) {
    autoBioAttempted.value = false;
    return;
  }

  const step = authStep.value;
  const mode = authMode.value;
  const enrolled = bioEnrolled.value;
  const busy = isBusy.value;
  const isFilesystem = mode === 'filesystem';
  const isRemote = mode === 'remote';
  const isSessionValid = isRemoteSessionValid();
  const isRemotePasswordStep = isRemote && !isSessionValid && !remotePasswordStage.value;
  const localCreate = mode === 'local' && !authHasLocalData.value;

  if (
    step === 'unlock' &&
    enrolled &&
    !busy &&
    !isFilesystem &&
    !localCreate &&
    !isRemotePasswordStep &&
    !autoBioAttempted.value
  ) {
    autoBioAttempted.value = true;
    void unlockWithBiometrics();
  }
});

const LockScreen = () => {
  const step = authStep.value;
  const mode = authMode.value;
  const isFilesystem = mode === 'filesystem';
  const isRemote = mode === 'remote';
  const isLocal = mode === 'local';
  const isSessionValid = isRemoteSessionValid();

  const isRemotePasswordStep = isRemote && !isSessionValid && !remotePasswordStage.value;

  const passwordStepDisabled = isBusy.value || !username.value.trim() || !password.value;
  const unlockDisabled = isBusy.value || (!isFilesystem && !passphrase.value.trim());

  const modeLabel = isLocal ? 'Local' : isRemote ? 'Remote' : 'File';

  return html`
    <div class="bottom-sheet" data-auth-mode=${mode} role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <div class="sheet-handle" aria-hidden="true"></div>
      <div class="sheet-content">

        ${step === 'choose-mode' && html`
          <h1 class="auth-title" id="auth-title">Choose Storage</h1>
          <div class="auth-mode-switch" role="group" aria-label="Storage mode">
            <button type="button" class=${'auth-mode-btn' + (isLocal ? ' is-active' : '')}
              onClick=${() => pickMode('local')}>Local</button>
            <button type="button" class=${'auth-mode-btn' + (isRemote ? ' is-active' : '')}
              onClick=${() => pickMode('remote')}>Remote</button>
            <button type="button" class=${'auth-mode-btn' + (isFilesystem ? ' is-active' : '')}
              onClick=${() => pickMode('filesystem')}>File</button>
          </div>
          ${unlockError.value && html`<div class="form-error">${unlockError.value}</div>`}
          <div class="auth-memory-skip">
            <button type="button" class="auth-memory-link" onClick=${continueInMemory} disabled=${isBusy.value}>
              Skip — continue in memory
            </button>
          </div>
        `}

        ${step === 'unlock' && html`
          <h1 class="auth-title" id="auth-title">Unlock Virgulas</h1>
          <div class="status-text">
            ${isLocal && (isLocalCreate() ? 'Secure Your Workspace' : 'Encrypted Local Storage')}
            ${isRemote && (isSessionValid ? 'Remote — ' + (authUser.value?.email || '') : 'Remote — sign in')}
            ${isFilesystem && 'File'}
          </div>

          ${isRemotePasswordStep && html`
            <form onSubmit=${submitRemotePassword}>
              <div class="input-group">
                <label for="auth-username" class="input-label">Email</label>
                <input value=${username.value} onInput=${(e: any) => username.value = e.target.value}
                  id="auth-username" type="text" placeholder="you@example.com" class="input-field" autocomplete="email" />
              </div>
              <div class="input-group">
                <label for="auth-password" class="input-label">Account password</label>
                <input value=${password.value} onInput=${(e: any) => password.value = e.target.value}
                  id="auth-password" type="password" placeholder="Account password" class="input-field" autocomplete="current-password" />
              </div>
              ${unlockError.value && html`<div class="form-error">${unlockError.value}</div>`}
              <button type="submit" class="lock-submit-btn" disabled=${passwordStepDisabled} aria-label="Continue" title="Continue">
                ${isBusy.value ? '...' : 'Continue'}
              </button>
            </form>

            <div class="auth-secondary-actions">
              <button type="button" class="toolbar-btn" disabled=${isBusy.value || !username.value.trim() || !password.value}
                onClick=${submitSignUp}>
                ${isBusy.value ? '...' : 'Sign up'}
              </button>
            </div>
          `}

          ${!isRemotePasswordStep && html`
            ${isRemote && isSessionValid && html`
              <div class="auth-secondary-actions">
                <button type="button" class="toolbar-btn" disabled=${isBusy.value} onClick=${submitSignOut}>
                  ${isBusy.value ? 'Signing out...' : 'Sign out'}
                </button>
              </div>
            `}

            ${isRemote && !isSessionValid && remotePasswordStage.value && html`
              <div class="auth-secondary-actions">
                <button type="button" class="toolbar-btn" disabled=${isBusy.value}
                  onClick=${() => { remotePasswordStage.value = false; unlockError.value = ''; }}>Back</button>
              </div>
            `}

            <form onSubmit=${submitUnlock}>
              ${!isFilesystem && html`
                <label for="auth-passphrase" class="visually-hidden">
                  ${isLocalCreate() ? 'Create a passphrase' : 'Encryption passphrase'}
                </label>
                <input
                  value=${passphrase.value}
                  onInput=${(e: any) => passphrase.value = e.target.value}
                  id="auth-passphrase"
                  type="password"
                  placeholder=${isLocalCreate() ? 'Create passphrase' : 'Passphrase'}
                  class="huge-input"
                  autocomplete=${isLocalCreate() ? 'new-password' : 'current-password'}
                />
                <p class="auth-hint">If you lose this passphrase, your data cannot be recovered — not even by Virgulas.</p>
              `}
              ${unlockMessage.value && html`<div class="form-success">${unlockMessage.value}</div>`}
              ${unlockError.value && html`<div class="form-error">${unlockError.value}</div>`}
              ${canResetLocalData.value && html`
                <div class="auth-secondary-actions">
                  <button type="button" class="toolbar-btn" disabled=${isBusy.value || !passphrase.value.trim()}
                    onClick=${submitResetLocalData}>Reset Local Data With New Passphrase</button>
                </div>
              `}
              ${canResetRemoteData.value && html`
                <div class="auth-secondary-actions">
                  <button type="button" class="toolbar-btn" disabled=${isBusy.value || !passphrase.value.trim()}
                    onClick=${submitResetRemoteData}>Reset Remote Data With New Passphrase</button>
                </div>
              `}
              <button type="submit" class="lock-submit-btn" disabled=${unlockDisabled} aria-label="Unlock" title="Unlock">
                ${isBusy.value ? '...' : isFilesystem ? 'Open File' : 'Unlock'}
              </button>
            </form>
          `}

          <button type="button" class="subtle-switch" onClick=${requestChangeMode} disabled=${isBusy.value}>
            Change mode (${modeLabel})
          </button>
          <div class="auth-memory-skip">
            <button type="button" class="auth-memory-link" onClick=${continueInMemory} disabled=${isBusy.value}>
              Skip — continue in memory
            </button>
          </div>
        `}

      </div>
    </div>
  `;
};

const CaptureSurface = () => {
  const appHref = typeof window === 'undefined'
    ? '/'
    : `${window.location.pathname}${window.location.search}${window.location.hash}`;

  return html`
    <div class="capture-only">
      ${captureSaved.value === null ? null : html`
        <div class="capture-only-card">
          <div class="capture-only-logo">Virgulas</div>
          ${captureSaved.value
            ? html`
              <p class="capture-only-title" role="status">Saved to the ${inboxNodeName.value} queue</p>
              <p class="capture-only-hint">It will be filed into your document the next time you unlock secure storage.</p>`
            : html`
              <p class="capture-only-title" role="status">Quick capture could not be saved on this device</p>
              <p class="capture-only-hint">Check that this browser allows local storage, then try again.</p>`}
          <a class="btn btn-secondary" href=${appHref}>Open Virgulas</a>
        </div>`}
      ${quickCaptureOpen.value && html`<${QuickCapturePrompt} />`}
      <${QuickCaptureToast} />
    </div>`;
};

const QuickCapturePrompt = () => {
  if (!quickCaptureOpen.value) return null;

  const locked = persistence.isLocked() || persistence.isMemory();
  return html`
    <div class="modal-overlay quick-capture-overlay"
      onClick=${(e: any) => { if (e.target === e.currentTarget) closeQuickCapture(); }}>
      <div class="modal-dialog quick-capture-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-capture-title">
        <div class="modal-header">
          <h2 class="modal-title" id="quick-capture-title">Quick capture</h2>
          <button class="modal-close" type="button" onClick=${closeQuickCapture} aria-label="Close">×</button>
        </div>
        <form onSubmit=${submitQuickCapture}>
          <label class="input-label" for="quick-capture-input">Add to ${inboxNodeName.value}</label>
          <textarea
            id="quick-capture-input"
            class="input-field quick-capture-input"
            rows="4"
            value=${quickCaptureText.value}
            onInput=${(e: any) => quickCaptureText.value = e.currentTarget.value}
            onKeyDown=${(e: any) => {
              if (e.key === 'Escape') {
                closeQuickCapture();
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            ref=${(el: any) => {
              if (el && document.activeElement !== el) el.focus();
            }}
            placeholder="What do you want to remember?"
          ></textarea>
          <p class="admin-hint">
            ${locked
              ? `This stays on this device and will be filed after you unlock secure storage.`
              : `This will be added to your ${inboxNodeName.value} node.`}
          </p>
          <div class="options-row quick-capture-actions">
            <button type="button" class="btn btn-secondary" onClick=${closeQuickCapture}>Cancel</button>
            <button type="submit" class="btn btn-primary">Add to ${inboxNodeName.value}</button>
          </div>
        </form>
      </div>
    </div>`;
};

const QuickCaptureToast = () => quickCaptureNotice.value
  ? html`<div class="quick-capture-toast" role="status">${quickCaptureNotice.value}</div>`
  : null;

const SecureStoragePrompt = () => {
  if (persistence.isLocked() || !persistence.isMemory()) return null;

  return html`
    <button type="button" class="app-node" onClick=${openSecureStorageSetup}>
      <div class="app-node-icon" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
      </div>
      <div>
        <div class="app-node-text">Enable Secure Storage</div>
        <div class="app-node-sub">Your document is currently only in memory. Tap to save locally.</div>
      </div>
    </button>
  `;
};

const REPO_URL = 'https://github.com/pitermarx/Virgulas';

const OptionsModal = () => {
  if (!optionsOpen.value) return null;

  const currentMode = persistence.getMode();
  const info = accountInfo.value;
  const hasPassphrase = currentMode === 'local' || currentMode === 'remote';
  const isRemote = currentMode === 'remote';

  function handleThemeToggle() {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const fallback = prefersDark ? 'dark' : 'light';
    const current = document.documentElement.getAttribute('data-theme') || fallback;
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.theme.set(next);
  }

  async function handleLock() {
    optionsOpen.value = false;
    persistence.lock();
    authMode.value = 'local';
    authScenario.value = authHasLocalData.value ? 'local-present-no-session' : 'empty-local';
    authStep.value = 'unlock';
    autoBioAttempted.value = false;
    await loadLockedBackgroundIntro();
  }

  async function handleSignOut() {
    optionsOpen.value = false;
    isBusy.value = true;
    try {
      await persistence.signOut();
      authUser.value = null;
      remotePasswordStage.value = false;
      await persistence.unlock('', { mode: 'memory' });
      persistence.setPreferredMode('memory');
      stagedMemoryDocJson = null;
      document.body.setAttribute('data-main-view', 'rendered');
    } catch (err) {
      unlockError.value = String((err as { message?: string } | null)?.message || 'Failed to sign out.');
    } finally {
      isBusy.value = false;
    }
  }

  async function handleChangeFile() {
    optionsOpen.value = false;
    await persistence.pickNewFile();
  }

  async function handlePurge() {
    const purgeLabel = currentMode === 'remote'
      ? 'Clear browser session and sign out? Your remote data on the server is unaffected.'
      : currentMode === 'filesystem'
        ? 'Clear the remembered file handle and local session? Your .vmd file on disk is unaffected.'
        : 'Delete locally encrypted data? This cannot be undone.';
    if (!confirm(purgeLabel)) return;
    optionsOpen.value = false;

    if (currentMode === 'memory') {
      const introText = await getIntroText();
      outline.reset();
      if (introText && introText.trim()) {
        outline.setRootVMD(introText);
      } else {
        outline.addChild('root', { text: '' });
      }
      return;
    }

    persistence.reset();
    authHasLocalData.value = false;
    authUser.value = null;
    // Reload into memory mode so the intro appears
    await persistence.unlock('', { mode: 'memory' });
    persistence.setPreferredMode('memory');
    document.body.setAttribute('data-main-view', 'rendered');
  }

  return html`
    <div class="modal-overlay" onClick=${(e: any) => { if (e.target === e.currentTarget) optionsOpen.value = false; }}>
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="options-title">
        <div class="modal-header">
          <h2 class="modal-title" id="options-title">Options</h2>
          <button class="modal-close" onClick=${() => optionsOpen.value = false} aria-label="Close">×</button>
        </div>
        <div class="modal-body options-body admin-body">

          <dl class="admin-info">
            <dt>Mode</dt>
            <dd>${currentMode}${hasPassphrase ? ' · encrypted' : currentMode === 'filesystem' ? ' · not encrypted' : ' · in-memory only'}</dd>

            <dt>Email</dt>
            <dd>
              ${!isRemote
                ? html`${info.email || '—'}`
                : editingOption.value === 'email'
                  ? html`<form class="admin-inline-form" onSubmit=${submitChangeEmail}>
                      <input id="admin-email" type="email" value=${newEmail.value}
                        onInput=${(e: any) => newEmail.value = e.target.value}
                        class="input-field" placeholder="New email" autocomplete="email" />
                      <button type="submit" class="btn btn-secondary" disabled=${adminBusy.value}>Save</button>
                      <button type="button" class="btn btn-secondary" onClick=${() => editingOption.value = null}>Cancel</button>
                    </form>`
                  : html`<div class="admin-inline-row">
                      <span class="admin-inline-value">${info.email || '—'}</span>
                      <button type="button" class="btn btn-secondary" onClick=${() => editingOption.value = 'email'} aria-label="Change email">Change</button>
                    </div>`}
            </dd>

            ${isRemote && html`
              <dt>Password</dt>
              <dd>
                ${editingOption.value === 'password'
                  ? html`<form class="admin-inline-form" onSubmit=${submitChangePassword}>
                      <input id="admin-password" type="password" value=${newPassword.value}
                        onInput=${(e: any) => newPassword.value = e.target.value}
                        class="input-field" placeholder="New password" autocomplete="new-password" />
                      <button type="submit" class="btn btn-secondary" disabled=${adminBusy.value}>Save</button>
                      <button type="button" class="btn btn-secondary" onClick=${() => editingOption.value = null}>Cancel</button>
                    </form>`
                  : html`<div class="admin-inline-row">
                      <span class="admin-inline-value">••••••••</span>
                      <button type="button" class="btn btn-secondary" onClick=${() => editingOption.value = 'password'} aria-label="Change password">Change</button>
                    </div>`}
              </dd>
            `}

            ${hasPassphrase && html`
              <dt>Passphrase</dt>
              <dd>
                ${editingOption.value === 'passphrase'
                  ? html`<form class="admin-inline-form" onSubmit=${submitChangePassphrase}>
                      <input id="admin-passphrase" type="password" value=${newPassphrase.value}
                        onInput=${(e: any) => newPassphrase.value = e.target.value}
                        class="input-field" placeholder="New passphrase" autocomplete="new-password" />
                      <button type="submit" class="btn btn-secondary" disabled=${adminBusy.value}>Save</button>
                      <button type="button" class="btn btn-secondary" onClick=${() => editingOption.value = null}>Cancel</button>
                    </form>`
                  : html`<div class="admin-inline-row">
                      <span class="admin-inline-value">••••••••</span>
                      <button type="button" class="btn btn-secondary" onClick=${() => editingOption.value = 'passphrase'} aria-label="Change passphrase">Change</button>
                    </div>`}
              </dd>
            `}

            ${hasPassphrase && html`
              <dt>Blob</dt>
              <dd class="admin-inline-value">${info.encryptedBytes} chars · AES-GCM-256 · PBKDF2 ${DEFAULT_ITERATIONS / 1000}k</dd>
            `}
          </dl>

          ${hasPassphrase && html`
            <section class="admin-section">
              <h3 class="admin-section-title">Biometric unlock</h3>
              <p class="admin-hint">
                ${biometrics.isSupported()
        ? bioEnrolled.value
          ? 'Unlocks with your fingerprint, face, or device PIN.'
          : 'Unlock without typing the passphrase — it is sealed on this device.'
        : 'Not supported in this browser.'}
              </p>
              ${biometrics.isSupported() && html`
                <div class="options-row">
                  ${!bioEnrolled.value && html`
                    <button class="btn btn-secondary" onClick=${enrollBiometric} disabled=${adminBusy.value}>Enable on this device</button>
                  `}
                  ${bioEnrolled.value && html`
                    <button class="btn btn-secondary" onClick=${forgetBiometric} disabled=${adminBusy.value}>Forget this device</button>
                  `}
                </div>
              `}
            </section>
          `}

          <section class="admin-section">
            <h3 class="admin-section-title">Quick capture</h3>
            <p class="admin-hint">Captures queue on this device (unencrypted) and are filed into your Inbox node on unlock.</p>

            <h4 class="admin-subtitle">Ways to capture</h4>
            <ul class="admin-list">
              <li><strong>Installed app:</strong> long-press the icon, or share text to Virgulas.</li>
              <li><strong>Automation:</strong> open <code class="admin-code">/?quick-add=your%20text</code> (URL-encoded).</li>
              <li><strong>Bookmarklet:</strong> click <em>Save to</em> to copy it, or drag it onto your bookmarks bar; then click the bookmark on any page.</li>
            </ul>

            <div class="admin-inline-form">
              <a class="btn btn-secondary" href=${bookmarkletHref} draggable="true"
                title="Click to copy, or drag onto your bookmarks bar"
                onClick=${handleBookmarkletClick}>Save to</a>
              <input id="admin-inbox-node-name" type="text" value=${inboxNodeName.value}
                onChange=${handleInboxNodeNameChange} class="input-field" maxlength="100"
                autocomplete="off" aria-label="Inbox node name" />
            </div>
            <p class="admin-hint">
              ${bookmarkletCopied.value
                ? html`Bookmarklet copied — paste it as the URL of a new bookmark.`
                : html`Captures the page as <code class="admin-code">[title](url)</code>, with highlighted text as the description.`}
            </p>
          </section>

          <section class="admin-section">
            <h3 class="admin-section-title">Data</h3>
            <div class="options-row">
              <button class="btn btn-secondary" onClick=${exportDoc}>Export .vmd backup</button>
              <label class="btn btn-secondary admin-file-btn">
                Import .vmd
                <input type="file" accept=".vmd,text/plain" style="display:none" onChange=${importDoc} />
              </label>
            </div>
          </section>

          <div class="options-row">
            <button class="btn btn-secondary" onClick=${handleThemeToggle}>Toggle theme</button>
          </div>
          <div class="options-row">
            <a href=${REPO_URL} target="_blank" rel="noopener noreferrer" class="btn btn-secondary">Source repository ↗</a>
          </div>

          ${currentMode === 'remote' && html`
            <div class="options-row">
              <button class="btn btn-secondary" onClick=${handleSignOut} disabled=${isBusy.value}>Sign out</button>
            </div>
          `}
          ${currentMode === 'local' && html`
            <div class="options-row">
              <button class="btn btn-secondary" onClick=${handleLock}>Lock</button>
            </div>
          `}
          ${currentMode === 'filesystem' && html`
            <div class="options-row">
              <button class="btn btn-secondary" onClick=${handleChangeFile}>Change file</button>
            </div>
          `}
          ${currentMode !== 'memory' && html`
            <div class="options-row options-row-danger">
              <button class="btn btn-danger" onClick=${handlePurge}>
                ${currentMode === 'remote' ? 'Sign out & clear session' : currentMode === 'filesystem' ? 'Clear file session' : 'Delete local data'}
              </button>
            </div>
          `}

          ${adminError.value && html`<div class="form-error">${adminError.value}</div>`}
          ${adminMessage.value && html`<div class="form-success">${adminMessage.value}</div>`}

          <p class="admin-hint admin-footer-note">
            Account deletion and signing out other sessions are not available yet. Your data is always encrypted before it leaves this device — the server cannot read it, and there is no way to reset a forgotten passphrase.
          </p>

          <div class="options-footer-meta">Version <span class="options-footer-version" data-app-version>${appVersion.value}</span></div>
        </div>
      </div>
    </div>`;
};

const Splash = () => {
  const ready = appReady.value;
  let isLocked = false;

  // `transitionend` is the normal path to removal. This timer is the safety net
  // for a transition that never runs (reduced motion, background tab). It is
  // derived from the element's own computed transition so it cannot drift from
  // the CSS, and is scheduled after the `hidden` class has been committed.
  useEffect(() => {
    if (!ready) return;
    const element = document.getElementById('splash');
    const styles = element ? window.getComputedStyle(element) : null;
    const seconds = styles
      ? (parseFloat(styles.transitionDuration) || 0) + (parseFloat(styles.transitionDelay) || 0)
      : 0;
    const fadeMs = seconds > 0 ? seconds * 1000 : DEFAULT_SPLASH_FADE_MS;
    splashFallbackTimer = setTimeout(dismissSplash, fadeMs + 400);
    return () => {
      if (splashFallbackTimer !== null) {
        clearTimeout(splashFallbackTimer);
        splashFallbackTimer = null;
      }
    };
  }, [ready]);

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
        onTransitionEnd=${(event: TransitionEvent) => {
          if (event.propertyName === 'opacity' && event.target === event.currentTarget) dismissSplash();
        }}
      >
        <div class="logo">Virgulas</div>
        <div class="tagline">Local-first browser outliner</div>
      </div>`}

    ${ready && html`
    <div class="app-shell">
      <div class=${`main-view ${isLocked ? 'is-locked' : ''}`}>
        <div class="main-content">
          <${MainToolbar} />
          <${SecureStoragePrompt} />
          <${Outline} />
        </div>
        <${StatusToolbar} />
        ${!isLocked && html`<${OptionsModal} />`}
        ${!isLocked && html`<${ConflictModal} />`}
        ${!isLocked && html`<${TasksPanel} />`}
      </div>
      ${isLocked && html`<${LockScreen} />`}
      <${QuickCapturePrompt} />
      <${QuickCaptureToast} />
    </div>
    `}
  `;
};

if (captureOnly && initialCaptureIntent) {
  startCaptureOnly(initialCaptureIntent);
} else {
  render(html`<${Splash} />`, document.getElementById('app')!);
  consumeQuickCaptureUrl();
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', consumeQuickCaptureUrl);
    window.addEventListener('popstate', consumeQuickCaptureUrl);
  }
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

// ── Introspection surface for e2e specs ──────────────────────────────────────
// The app ships as a single bundle; specs import these from the bundle so they
// observe the exact same module singletons the running app uses.
export { default as outline } from './outline.js'
export { default as persistence } from './persistence.js'
export { default as inbox } from './inbox.js'
export { encrypt, decrypt, randomId, generateSalt } from './crypto2.js'
export { pendingConflicts, mergeDocuments } from './sync.js'
export { currentSearchMatchId, getFirstClosedParent } from './search.js'

// Styles are bundled by Bun. Modules may import their own CSS alongside this
// entry; all imports are concatenated (in order) into dist/js/app.css.
import '../css/base.css'
import '../css/controls.css'
import '../css/shell.css'
import '../css/outline.css'
import '../css/account.css'
import '../css/views.css'
import '../css/tasks.css'
