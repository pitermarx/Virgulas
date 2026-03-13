// @ts-check
// Global end-to-end integration test.
//
// This test covers all major features in a realistic user journey:
//   1. Open the Markdown modal and save an empty document (clean slate)
//   2. Sign in using the tester@virgulas.com account (via mocked Supabase)
//   3. Create, edit, and delete bullets
//   4. Indentation (Tab / Shift+Tab)
//   5. Moving bullets (Alt+ArrowUp / Alt+ArrowDown)
//   6. Collapse/expand and keyboard shortcut
//   7. Description editing
//   8. Markdown import/export round-trip
//   9. Search
//  10. Zoom in/out
//  11. Undo
//  12. Sign out
//
// The Supabase vendor script is replaced with a lightweight mock so that
// auth and sync API calls succeed without a real backend, making the test
// self-contained and runnable in every environment.

import { test, expect } from '@playwright/test';

// ── Mock Supabase vendor script ───────────────────────────────────────────────

const MOCK_USER = {
    id: '6d7b1ecc-2af7-4063-a7d0-04b1ba8b1ce7',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'tester@virgulas.com',
    email_confirmed_at: '2026-03-12T18:00:00Z',
    created_at: '2026-03-12T18:00:00Z',
    updated_at: '2026-03-12T18:00:00Z',
};

// A mock JWT whose payload encodes the test user (signature is not validated
// client-side by the Supabase JS library so any string works as signature).
const MOCK_JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
    '.eyJzdWIiOiI2ZDdiMWVjYy0yYWY3LTQwNjMtYTdkMC0wNGIxYmE4YjFjZTciLCJlbWFpbCI6InRlc3RlckB2aXJndWxhcy5jb20iLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImF1ZCI6ImF1dGhlbnRpY2F0ZWQiLCJleHAiOjk5OTk5OTk5OTksImlhdCI6MTcwMDAwMDAwMH0' +
    '.fakesignature';

const MOCK_SUPABASE_SCRIPT = /* javascript */ `
window.supabase = {
  createClient: function () {
    var authCallbacks = [];
    var currentSession = null;
    var mockUser = ${JSON.stringify(MOCK_USER)};
    var mockSession = {
      access_token: '${MOCK_JWT}',
      refresh_token: 'mock_refresh_token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: 9999999999,
      user: mockUser
    };

    return {
      auth: {
        getSession: function () {
          return Promise.resolve({ data: { session: currentSession }, error: null });
        },
        onAuthStateChange: function (cb) {
          authCallbacks.push(cb);
          return { data: { subscription: { unsubscribe: function () {} } } };
        },
        signInWithPassword: function (creds) {
          if (creds.email === 'tester@virgulas.com' && creds.password === 'virgulas') {
            currentSession = mockSession;
            setTimeout(function () {
              authCallbacks.forEach(function (cb) { cb('SIGNED_IN', mockSession); });
            }, 50);
            return Promise.resolve({ data: { user: mockUser, session: mockSession }, error: null });
          }
          return Promise.resolve({ data: { user: null, session: null }, error: { message: 'Invalid login credentials' } });
        },
        signUp: function () {
          return Promise.resolve({ data: { user: null, session: null }, error: { message: 'Signups not available in test mode' } });
        },
        signOut: function () {
          currentSession = null;
          setTimeout(function () {
            authCallbacks.forEach(function (cb) { cb('SIGNED_OUT', null); });
          }, 50);
          return Promise.resolve({ error: null });
        }
      },
      from: function () {
        return {
          select: function () {
            return {
              eq: function () {
                return {
                  maybeSingle: function () { return Promise.resolve({ data: null, error: null }); },
                  single:      function () { return Promise.resolve({ data: null, error: null }); }
                };
              }
            };
          },
          upsert: function () { return Promise.resolve({ error: null }); },
          delete: function () {
            return { eq: function () { return Promise.resolve({ error: null }); } };
          }
        };
      }
    };
  }
};
`;

// ── Test setup ────────────────────────────────────────────────────────────────

async function setupPage(page) {
    // Intercept the Supabase vendor script and replace it with the mock so that
    // auth and sync calls succeed without a real backend.
    await page.route('**/vendor/supabase.js', route =>
        route.fulfill({ contentType: 'application/javascript', body: MOCK_SUPABASE_SCRIPT })
    );

    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    // Encryption is mandatory: set up passphrase on first load (no salt yet)
    await page.waitForSelector('#modal-passphrase:not(.hidden)');
    await page.fill('#passphrase-input', 'testpass');
    await page.fill('#passphrase-confirm', 'testpass');
    await page.click('#btn-passphrase-submit');
    // After clearing localStorage the app may render the ghost row before any bullets
    await page.waitForSelector('#ghost-row');
}

// ── Global flow ───────────────────────────────────────────────────────────────

test.describe('Global integration flow', () => {
    // Each test in this suite uses the mock Supabase and starts fresh.
    test.beforeEach(async ({ page }) => {
        await setupPage(page);
    });

    // ── 1. Markdown modal — save empty document ───────────────────────────────

    test('Step 1: open Markdown modal and save empty document', async ({ page }) => {
        // The app has seed bullets by default; open the modal
        const mdBtn = page.locator('#toolbar').getByText('Markdown');
        await mdBtn.click();
        await expect(page.locator('#modal-markdown')).toBeVisible();

        // Replace the content with a comment line that contains no bullet markers.
        // applyMarkdownImport guards against empty strings so we need at least one
        // non-empty line; a line that doesn't match the bullet pattern produces a
        // root with no children — i.e. an empty document.
        await page.locator('#markdown-text').fill('# empty document');
        await page.locator('#btn-apply-markdown').click();

        await expect(page.locator('.bullet-row')).toHaveCount(0);
        await expect(page.locator('#ghost-row')).toBeVisible();
    });

    // ── 2. Sign in ────────────────────────────────────────────────────────────

    test('Step 2: sign in with tester@virgulas.com', async ({ page }) => {
        // Open Options → Sign in
        await page.click('#btn-options');
        await expect(page.locator('#btn-sign-in')).toBeVisible();
        await page.click('#btn-sign-in');
        await expect(page.locator('#modal-login')).not.toHaveClass(/hidden/);

        // Fill in credentials
        await page.fill('#login-email', 'tester@virgulas.com');
        await page.fill('#login-password', 'virgulas');
        await page.click('#btn-login-submit');

        // The login modal should close after a successful sign-in
        await expect(page.locator('#modal-login')).toHaveClass(/hidden/);

        // The options modal is still open — wait for the auth UI to reflect the
        // signed-in user (renderAuthUI fires via onAuthStateChange callback).
        await expect(page.locator('.auth-user-email')).toContainText('tester@virgulas.com');
        await expect(page.locator('#btn-sign-out')).toBeVisible();

        // Close options modal
        await page.keyboard.press('Escape');
    });

    test('Step 2b: wrong password shows an error', async ({ page }) => {
        await page.click('#btn-options');
        await page.click('#btn-sign-in');
        await page.fill('#login-email', 'tester@virgulas.com');
        await page.fill('#login-password', 'wrongpassword');
        await page.click('#btn-login-submit');

        await expect(page.locator('#login-error')).not.toHaveClass(/hidden/);
        await expect(page.locator('#login-error')).toContainText('Invalid login credentials');
    });

    // ── 3. Create and edit bullets ────────────────────────────────────────────

    test('Step 3: create bullets via ghost row and edit text', async ({ page }) => {
        // Start with an empty document by importing non-bullet markdown
        await page.locator('#toolbar').getByText('Markdown').click();
        await page.locator('#markdown-text').fill('# empty document');
        await page.locator('#btn-apply-markdown').click();
        await expect(page.locator('.bullet-row')).toHaveCount(0);

        // Create the first bullet via the ghost row
        await page.locator('#ghost-row').click();
        await expect(page.locator('#ghost-text')).toBeFocused();
        await page.keyboard.type('First item');
        await page.keyboard.press('Enter');
        await expect(page.locator('.bullet-row')).toHaveCount(1);

        // Ghost row should be focused and empty after committing the first item
        await expect(page.locator('#ghost-text')).toBeFocused();
        await expect(page.locator('#ghost-text')).toBeEmpty();

        // Create a second bullet
        await page.keyboard.type('Second item');
        await page.keyboard.press('Enter');
        await expect(page.locator('.bullet-row')).toHaveCount(2);

        // Edit the first bullet text
        const firstText = page.locator('.bullet-text').first();
        await firstText.click();
        await firstText.fill('First item (edited)');
        await firstText.blur();
        await expect(firstText).toContainText('First item (edited)');
    });

    // ── 4. Indentation ────────────────────────────────────────────────────────

    test('Step 4: indent and unindent bullets', async ({ page }) => {
        // Seed two bullets
        await page.locator('#toolbar').getByText('Markdown').click();
        await page.locator('#markdown-text').fill('- Parent\n- Child');
        await page.locator('#btn-apply-markdown').click();
        await expect(page.locator('.bullet-row')).toHaveCount(2);

        // Indent the second bullet (make it a child of the first)
        const secondText = page.locator('.bullet-text').nth(1);
        const secondRow  = page.locator('.bullet-row').nth(1);
        const marginBefore = await secondRow.evaluate(el => el.style.marginLeft);
        await secondText.click();
        await page.keyboard.press('Tab');
        const marginAfterIndent = await secondRow.evaluate(el => el.style.marginLeft);
        expect(marginAfterIndent).not.toBe(marginBefore);

        // Unindent it again — re-click to ensure focus before Shift+Tab
        await secondText.click();
        await page.keyboard.press('Shift+Tab');
        const marginAfterUnindent = await secondRow.evaluate(el => el.style.marginLeft);
        expect(marginAfterUnindent).not.toBe(marginAfterIndent);
    });

    // ── 5. Move bullets ───────────────────────────────────────────────────────

    test('Step 5: move bullets up and down with Alt+Arrow', async ({ page }) => {
        await page.locator('#toolbar').getByText('Markdown').click();
        await page.locator('#markdown-text').fill('- Alpha\n- Beta\n- Gamma');
        await page.locator('#btn-apply-markdown').click();

        const firstRow = page.locator('.bullet-row').first();
        const firstId = await firstRow.getAttribute('data-id');

        // Move first bullet down
        await page.locator('.bullet-text').first().click();
        await page.keyboard.press('Alt+ArrowDown');
        const newSecondRow = page.locator('.bullet-row').nth(1);
        await expect(newSecondRow).toHaveAttribute('data-id', firstId);

        // Re-focus the moved bullet before pressing Alt+ArrowUp
        await page.locator('.bullet-row').nth(1).locator('.bullet-text').click();
        await page.keyboard.press('Alt+ArrowUp');
        const restoredFirstRow = page.locator('.bullet-row').first();
        await expect(restoredFirstRow).toHaveAttribute('data-id', firstId);
    });

    // ── 6. Collapse / expand ──────────────────────────────────────────────────

    test('Step 6: collapse and expand a parent bullet', async ({ page }) => {
        await page.locator('#toolbar').getByText('Markdown').click();
        await page.locator('#markdown-text').fill('- Parent\n  - Child A\n  - Child B');
        await page.locator('#btn-apply-markdown').click();
        await expect(page.locator('.bullet-row')).toHaveCount(3);

        // Collapse via Ctrl+Space on the parent
        const parentText = page.locator('.bullet-row.has-children .bullet-text').first();
        await parentText.click();
        await page.keyboard.press('Control+Space');
        await expect(page.locator('.bullet-row')).toHaveCount(1);

        // Re-click the (now collapsed) parent row and expand via Ctrl+Space again
        await page.locator('.bullet-row').first().locator('.bullet-text').click();
        await page.keyboard.press('Control+Space');
        await expect(page.locator('.bullet-row')).toHaveCount(3);
    });

    // ── 7. Description editing ────────────────────────────────────────────────

    test('Step 7: add and edit a bullet description', async ({ page }) => {
        await page.locator('#toolbar').getByText('Markdown').click();
        await page.locator('#markdown-text').fill('- My bullet');
        await page.locator('#btn-apply-markdown').click();

        const bulletText = page.locator('.bullet-text').first();
        await bulletText.click();
        await page.keyboard.press('Shift+Enter');

        const desc = page.locator('.bullet-desc.editing').first();
        await expect(desc).toBeVisible();
        await desc.fill('A useful description');
        await desc.press('Escape');

        // The description view should now be visible with the entered text
        const descView = page.locator('.bullet-desc-view.visible').first();
        await expect(descView).toBeVisible();
        await expect(descView).toContainText('A useful description');
    });

    // ── 8. Markdown import/export round-trip ──────────────────────────────────

    test('Step 8: markdown import and export round-trip', async ({ page }) => {
        const mdBtn = page.locator('#toolbar').getByText('Markdown');

        // Import
        await mdBtn.click();
        await page.locator('#markdown-text').fill('- Item One\n  - Sub-item\n- Item Two');
        await page.locator('#btn-apply-markdown').click();
        await expect(page.locator('.bullet-row')).toHaveCount(3);

        // Export and verify format
        await mdBtn.click();
        const content = await page.locator('#markdown-text').inputValue();
        expect(content).toMatch(/^- Item One$/m);
        expect(content).toMatch(/^  - Sub-item$/m);
        expect(content).toMatch(/^- Item Two$/m);

        // Collapse Item One and re-export (should use '+' marker)
        await page.locator('#modal-markdown .modal-close').click();
        const firstText = page.locator('.bullet-text').first();
        await firstText.click();
        await page.keyboard.press('Control+Space');

        await mdBtn.click();
        const exportedCollapsed = await page.locator('#markdown-text').inputValue();
        expect(exportedCollapsed).toMatch(/^\+ Item One$/m);
        await page.locator('#modal-markdown .modal-close').click();
    });

    // ── 9. Search ─────────────────────────────────────────────────────────────

    test('Step 9: search highlights matching bullets', async ({ page }) => {
        await page.locator('#toolbar').getByText('Markdown').click();
        await page.locator('#markdown-text').fill('- Apple\n- Banana\n- Apricot');
        await page.locator('#btn-apply-markdown').click();

        // Open search with Ctrl+F
        await page.keyboard.press('Control+f');
        await expect(page.locator('#search-bar')).toBeVisible();

        await page.locator('#search-input').fill('Ap');
        await expect(page.locator('.bullet-row.search-match')).toHaveCount(2);

        const count = page.locator('#search-count');
        await expect(count).not.toHaveText('');

        // Close search
        await page.locator('#search-input').press('Escape');
        await expect(page.locator('#search-bar')).toBeHidden();
        await expect(page.locator('.bullet-row.search-match')).toHaveCount(0);
    });

    // ── 10. Zoom in / out ─────────────────────────────────────────────────────

    test('Step 10: zoom into a bullet and zoom back out', async ({ page }) => {
        await page.locator('#toolbar').getByText('Markdown').click();
        await page.locator('#markdown-text').fill('- Section\n  - Detail');
        await page.locator('#btn-apply-markdown').click();

        // Zoom into the parent by clicking its dot
        const dot = page.locator('.bullet-dot').first();
        await dot.click();
        await expect(page.locator('#zoom-title')).toBeVisible();
        await expect(page.locator('#zoom-title')).toBeFocused();
        await expect(page.locator('#breadcrumb')).toBeVisible();

        // Zoom out with Alt+ArrowLeft
        await page.keyboard.press('Alt+ArrowLeft');
        await expect(page.locator('#zoom-title')).toBeHidden();
    });

    // ── 11. Undo ──────────────────────────────────────────────────────────────

    test('Step 11: Ctrl+Z undoes the last operation', async ({ page }) => {
        await page.locator('#toolbar').getByText('Markdown').click();
        await page.locator('#markdown-text').fill('- Existing');
        await page.locator('#btn-apply-markdown').click();
        await expect(page.locator('.bullet-row')).toHaveCount(1);

        // Add a new bullet
        const existingText = page.locator('.bullet-text').first();
        await existingText.click();
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await expect(page.locator('.bullet-row')).toHaveCount(2);

        // Undo — should remove the new bullet
        await page.keyboard.press('Control+z');
        await expect(page.locator('.bullet-row')).toHaveCount(1);
    });

    // ── 12. Sign out ──────────────────────────────────────────────────────────

    test('Step 12: sign in then sign out', async ({ page }) => {
        // Sign in first
        await page.click('#btn-options');
        await page.click('#btn-sign-in');
        await page.fill('#login-email', 'tester@virgulas.com');
        await page.fill('#login-password', 'virgulas');
        await page.click('#btn-login-submit');
        await expect(page.locator('#modal-login')).toHaveClass(/hidden/);

        // The options modal is still open — verify signed-in state
        await expect(page.locator('#btn-sign-out')).toBeVisible();

        // Sign out
        await page.click('#btn-sign-out');

        // After sign-out the options modal should show Sign in again
        await expect(page.locator('#btn-sign-in')).toBeVisible();
        await expect(page.locator('.auth-user-email')).toHaveCount(0);
    });
});
