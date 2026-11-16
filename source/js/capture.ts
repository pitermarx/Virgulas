// Quick capture: the URL/share-target payload, the confirmation prompt, the
// device-local queue and the Inbox reconciliation.
//
// A capture URL is untrusted input (sec-01): it only pre-fills the prompt, and
// the queue write happens on the user's "Add". The cold-boot decision belongs to
// `app.ts`, which calls `startCaptureIfRequested()` before any auth bootstrap;
// confirming a capture-only visit hands back to it through `initCapture()`.

import { effect, signal } from '@preact/signals'
import { html, render } from 'htm/preact'
import inbox, { type CaptureIntent } from './inbox.js'
import persistence from './persistence.js'
import { bindDialogFocus } from './dialogs.js'

export const quickCaptureOpen = signal(false)
const quickCaptureText = signal('')
const quickCaptureNotice = signal('')
export const inboxNodeName = signal(inbox.getNodeName())

/**
 * The capture request awaiting confirmation. Held here so the share-target
 * description survives into the queue entry; never written on arrival.
 */
const pendingCaptureIntent = signal<CaptureIntent | null>(null)

// Decide the capture fast-path at module load: a capture URL is untrusted, so it
// renders only the confirmation prompt (no auth bootstrap, KDF, decryption or
// biometric prompt) until the user confirms.
const initialCaptureIntent = typeof window === 'undefined'
  ? null
  : inbox.parseCaptureUrl(new URL(window.location.href))
export const captureOnly = signal(initialCaptureIntent !== null)

let handOverToApp: (() => void) | null = null

/** The app injects how a confirmed capture visit boots the real app. */
export function initCapture(handOver: () => void) {
  handOverToApp = handOver
}

let quickCaptureNoticeTimer: ReturnType<typeof setTimeout> | null = null

function announceQuickCapture(message: string) {
  quickCaptureNotice.value = message
  if (quickCaptureNoticeTimer !== null) clearTimeout(quickCaptureNoticeTimer)
  quickCaptureNoticeTimer = setTimeout(() => {
    quickCaptureNotice.value = ''
    quickCaptureNoticeTimer = null
  }, 5000)
}

function reconcileInbox() {
  if (persistence.isLocked() || persistence.isMemory()) return 0
  const imported = inbox.reconcile()
  if (imported > 0) {
    announceQuickCapture(`Added ${imported} item${imported === 1 ? '' : 's'} to ${inbox.getNodeName()}.`)
  }
  return imported
}

function enqueueIncomingCapture(text: string, description = '') {
  if (!inbox.enqueue(text, description)) {
    announceQuickCapture('Quick capture could not be saved on this device.')
    return false
  }
  if (reconcileInbox() === 0) {
    announceQuickCapture(
      persistence.isLocked() || persistence.isMemory()
        ? `Saved to the ${inbox.getNodeName()} queue. Unlock secure storage to file it.`
        : `Saved to the ${inbox.getNodeName()} queue.`
    )
  }
  return true
}

function closeQuickCapture() {
  quickCaptureOpen.value = false
  quickCaptureText.value = ''
  pendingCaptureIntent.value = null
}

function submitQuickCapture(event: any) {
  event.preventDefault()
  if (!quickCaptureText.value.trim()) {
    announceQuickCapture('Enter some text before adding it.')
    return
  }

  if (captureOnly.value) {
    // Confirmed: the only place a URL-borne capture reaches the queue. The app
    // was never booted, so hand over to the normal boot at the unlock screen.
    if (!inbox.enqueue(quickCaptureText.value, pendingCaptureIntent.value?.description ?? '')) {
      announceQuickCapture('Quick capture could not be saved on this device.')
      return
    }
    closeQuickCapture()
    handOverToApp?.()
    return
  }

  if (enqueueIncomingCapture(quickCaptureText.value)) closeQuickCapture()
}

/** Remove the capture parameters so a reload or re-share does not queue twice. */
function stripCaptureParams(): string {
  const url = new URL(window.location.href)
  ;['quick-add', 'quick-capture', ...inbox.SHARE_TARGET_KEYS].forEach(key => url.searchParams.delete(key))
  const cleanUrl = `${url.pathname}${url.search ? `?${url.searchParams.toString()}` : ''}${url.hash}`
  window.history.replaceState(null, '', cleanUrl || '/')
  return cleanUrl || '/'
}

/** Handle capture URLs that arrive while the app is already running. */
export function consumeQuickCaptureUrl() {
  if (typeof window === 'undefined') return
  const intent = inbox.parseCaptureUrl(new URL(window.location.href))
  if (!intent) return

  pendingCaptureIntent.value = intent
  if (intent.kind === 'prefill') quickCaptureText.value = intent.text
  quickCaptureOpen.value = true
  stripCaptureParams()
}

/** The capture-only boot: render the confirmation prompt instead of the app. */
function startCaptureOnly(intent: CaptureIntent) {
  pendingCaptureIntent.value = intent
  if (intent.kind === 'prefill') quickCaptureText.value = intent.text
  quickCaptureOpen.value = true
  stripCaptureParams()
  render(html`<${CaptureSurface} />`, document.getElementById('app')!)
}

/**
 * The cold-boot decision. Returns true when a capture visit rendered only the
 * confirmation surface (the caller must then skip the auth bootstrap).
 */
export function startCaptureIfRequested(): boolean {
  if (!captureOnly.value || !initialCaptureIntent) return false
  startCaptureOnly(initialCaptureIntent)
  return true
}

// Reconcile a queue captured while locked as soon as a persisted document is
// available. Memory mode deliberately leaves it for a later secure unlock.
effect(() => {
  const locked = persistence.isLocked()
  const mode = persistence.getMode()
  if (locked || mode === 'memory') return
  reconcileInbox()
})

bindDialogFocus(quickCaptureOpen, {
  labelId: 'quick-capture-title',
  onEscape: closeQuickCapture,
  // The textarea is the reason the dialog exists; focus it, not Close.
  initial: () => document.querySelector<HTMLElement>('#quick-capture-input'),
})

const CaptureSurface = () => html`
  <div class="capture-only">
    ${quickCaptureOpen.value && html`<${QuickCapturePrompt} />`}
    <${QuickCaptureToast} />
  </div>`

export const QuickCapturePrompt = () => {
  if (!quickCaptureOpen.value) return null
  const locked = persistence.isLocked() || persistence.isMemory()
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
      closeQuickCapture()
      e.preventDefault()
      e.stopPropagation()
    }
  }}
            ref=${(el: any) => {
    if (el && document.activeElement !== el) el.focus()
  }}
            placeholder="What do you want to remember?"
          ></textarea>
          <p class="admin-hint">
            ${locked
    ? 'This stays on this device and will be filed after you unlock secure storage.'
    : `This will be added to your ${inboxNodeName.value} node.`}
          </p>
          <div class="options-row quick-capture-actions">
            <button type="button" class="btn btn-secondary" onClick=${closeQuickCapture}>Cancel</button>
            <button type="submit" class="btn btn-primary">Add to ${inboxNodeName.value}</button>
          </div>
        </form>
      </div>
    </div>`
}

export const QuickCaptureToast = () => quickCaptureNotice.value
  ? html`<div class="quick-capture-toast" role="status">${quickCaptureNotice.value}</div>`
  : null
