import { html, render } from 'htm/preact';
import { signal, effect, batch } from '@preact/signals';
import { Outline, StatusToolbar, MainToolbar } from "./node.js"
import persistence from './persistence.js';

const LockScreen = (function () {
  const localPass = signal('');
  const unlockError = signal('');
  async function onSubmit(e) {
    e.preventDefault();
    if (!localPass.value && unlockError.value) {
      // confirm reset if user tries to submit empty passphrase after an error
      if (!confirm('Are you sure you want to reset? This will erase all local data.')) {
        return;
      }
      persistence.reset();
      unlockError.value = '';
    }
    else {
      const success = await persistence.unlock(localPass.value);
      unlockError.value = success ? '' : 'Incorrect passphrase. Please try again or reset local data.';
      if (!success) {
        localPass.value = '';
      }
    };
  }
  return function LockScreen() {
    return html`
    <div class="auth-card">
    <h1 class="auth-title">Unlock Virgulas</h1>
    <p class="auth-subtitle">No local encrypted data yet. <br /> Create a passphrase to start in local mode.</p>
    <form onSubmit=${onSubmit}>
      <div class="input-group">
        <label for="create-a-passphrase" class="input-label">Create a passphrase</label>
        <input
          value=${localPass.value}
          onInput=${(e) => localPass.value = e.target.value}
          id="create-a-passphrase"
          type="password"
          placeholder="Create a passphrase"
          class="input-field"
          autofocus="true" />
      </div>
      ${unlockError.value && html`<div class="form-error">${unlockError}</div>`}
      ${unlockError.value && localPass.value === ''
        ? html`<button
              type="submit"
              class="lock-submit-btn"
              aria-label="Lock Reset"
              title="Lock Reset">
                <svg height="50px" fill="fill: var(--color-background);" viewBox="0 0 25 25">
                  <path d="
                    M13.16,3.17A8.83,8.83,0,1,1,5.76,16.8l1.4-1.11a7.05,7.05,0,1,0-1-4.57H8.6L5.3,14.41,2,11.12H4.38a8.83,8.83,0,0,1,8.78-7.95m2.57,7.21a.81.81,0,0,1,.81.81v3.9a.82.82,0,0,1-.82.82H11a.79.79,0,0,1-.75-.82V11a.79.79,0,0,1,.74-.81V9.46a2.39,2.39,0,0,1,2.71-2.37A2.47,2.47,0,0,1,15.8,9.57v.81m-1.11-.84A1.22,1.22,0,0,0,14,8.4a1.29,1.29,0,0,0-1.86,1.09v.89h2.57Z"/></svg>
              </button>`
        : html`<button
              type="submit"
              class="lock-submit-btn"
              disabled="${!localPass.value}"
              aria-label="Unlock"
              title="Unlock">
                <svg height="30px" fill="fill: var(--color-background);" viewBox="0 0 64 64" enable-background="new 0 0 64 64" xml:space="preserve">
                  <path d="
                    M52,24h-4v-8c0-8.836-7.164-16-16-16S16,7.164,16,16v8h-4c-2.211,0-4,1.789-4,4v32c0,2.211,1.789,4,4,4h40
                    c2.211,0,4-1.789,4-4V28C56,25.789,54.211,24,52,24z M32,48c-2.211,0-4-1.789-4-4s1.789-4,4-4s4,1.789,4,4S34.211,48,32,48z M40,24
                    H24v-8c0-4.418,3.582-8,8-8s8,3.582,8,8V24z"/>
                </svg>
              </button>`
      }
      </form>
    </div>`;
  }
}())

const Splash = (function (splashVisible) {
  setTimeout(() => splashVisible.value = false, 300);
  return function Splash() {
    if (splashVisible.value) return html`
    <div id="splash">\
      <div class="logo">Virgulas</div>
      <div class="tagline">Local-first browser outliner</div>
    </div>`;

    if (persistence.isLocked()) {
      return html`<${LockScreen} />`;
    }

    return html`<div class="main-view">
      <div class="main-content">
        <${MainToolbar} />
        <${Outline} />
      </div>
      <${StatusToolbar} />
    </div>`;
  }
}(signal(true)))

render(html`<${Splash} />`, document.getElementById('app'));
