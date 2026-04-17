import { test, expect, type Page } from './test';

const installMockSupabase = async (page: Page, options?: {
  userEmail?: string;
  authErrorMessage?: string;
  downloadData?: { salt: string; data: string; updated_at?: string } | null;
}) => {
  await page.addInitScript(({ userEmail, authErrorMessage, downloadData }) => {
    const initialServerRecord = downloadData
      ? {
        salt: downloadData.salt,
        data: downloadData.data,
        updated_at: downloadData.updated_at || new Date().toISOString()
      }
      : null;

    (window as any).__mockSupabaseState = {
      serverRecord: initialServerRecord
    };

    const sessionState = {
      user: userEmail ? { id: 'user-1', email: userEmail } : null as any
    };

    const queryBuilder = {
      select: () => queryBuilder,
      eq: () => queryBuilder,
      single: async () => (window as any).__mockSupabaseState.serverRecord
        ? { data: (window as any).__mockSupabaseState.serverRecord, error: null }
        : { data: null, error: { code: 'PGRST116' } },
      upsert: async (payload: { salt: string; data: string; updated_at: string }) => {
        (window as any).__mockSupabaseState.serverRecord = {
          salt: payload.salt,
          data: payload.data,
          updated_at: payload.updated_at
        };
        return { error: null };
      }
    };

    const client = {
      auth: {
        signInWithPassword: async ({ email }: { email: string }) => {
          if (authErrorMessage) return { data: { user: null }, error: { message: authErrorMessage } };
          sessionState.user = { id: 'user-1', email };
          return { data: { user: sessionState.user }, error: null };
        },
        signUp: async ({ email }: { email: string }) => {
          if (authErrorMessage) return { data: { user: null }, error: { message: authErrorMessage } };
          sessionState.user = { id: 'user-1', email };
          return { data: { user: sessionState.user }, error: null };
        },
        signOut: async () => {
          sessionState.user = null;
          return { error: null };
        },
        getUser: async () => ({ data: { user: sessionState.user }, error: null })
      },
      from: () => queryBuilder
    };

    Object.defineProperty(window, 'supabase', {
      configurable: true,
      get: () => ({
        createClient: () => client
      }),
      set: () => { }
    });

    localStorage.setItem('supabaseconfig', JSON.stringify({
      url: 'http://127.0.0.1:54321',
      key: 'anon'
    }));
  }, options ?? {});
};

const createEncryptedPayload = async (
  page: Page,
  passphrase: string,
  doc: Record<string, unknown>
) => {
  return await page.evaluate(async ({ passphrase, doc }: { passphrase: string; doc: any }) => {
    const { encrypt } = await import('/js/crypto2.js');
    const outline = (await import('/js/outline.js')).default;
    outline.reset();
    function loadChildren(children: any[], parentId: string) {
      for (const child of children || []) {
        outline.addChild(parentId, { id: child.id, text: child.text });
        loadChildren(child.children || [], child.id);
      }
    }
    loadChildren(doc.children || [], 'root');
    const json = outline.serialize();
    const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
    const salt = btoa(String.fromCharCode(...saltBytes));
    const data = await encrypt(json, passphrase, salt);
    return { salt, data };
  }, { passphrase, doc });
};

const seedEncryptedLocalDoc = async (
  page: Page,
  passphrase: string,
  doc: Record<string, unknown>
) => {
  await page.evaluate(async ({ passphrase, doc }: { passphrase: string; doc: any }) => {
    localStorage.clear();
    const { encrypt } = await import('/js/crypto2.js');
    const outline = (await import('/js/outline.js')).default;
    outline.reset();
    function loadChildren(children: any[], parentId: string) {
      for (const child of children || []) {
        outline.addChild(parentId, { id: child.id, text: child.text });
        loadChildren(child.children || [], child.id);
      }
    }
    loadChildren(doc.children || [], 'root');
    const json = outline.serialize();
    const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
    const salt = btoa(String.fromCharCode(...saltBytes));
    const encrypted = await encrypt(json, passphrase, salt);
    localStorage.setItem('vmd_data_enc', `${salt}|${encrypted}`);
    localStorage.setItem('vmd_last_mode', 'local');
  }, { passphrase, doc });
};

test.describe('Authentication', () => {
  test('first run flow: set passphrase', async ({ page }) => {
    // Simulate a user who chose local mode before but has no data yet
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'local');
    });
    await page.goto('/');

    // Check for "Set Passphrase" screen
    await expect(page.getByRole('heading', { name: /Unlock Virgulas/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlock' })).toBeDisabled();
    await expect(page.getByLabel('Create a passphrase')).toBeVisible();

    // Fill passphrase
    await page.getByLabel('Create a passphrase').fill('correct-horse');
    await page.getByRole('button', { name: 'Unlock' }).click();

    // Check for main app
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await expect(page.locator('.status-mode')).toHaveText('Local');

    // Verify data is stored encrypted
    await expect.poll(async () => {
      return await page.evaluate(() => localStorage.getItem('vmd_data_enc'));
    }).toContain('|');
  });

  test('remote mode requires username password and passphrase before unlock', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'local');
    });
    await page.goto('/');

    await page.getByRole('button', { name: 'Remote' }).click();

    const unlockButton = page.getByRole('button', { name: 'Unlock' });
    await expect(unlockButton).toBeDisabled();

    await page.getByLabel('Email').fill('user@virgulas.com');
    await expect(unlockButton).toBeDisabled();

    await page.getByLabel('Account password').fill('account-password');
    await expect(unlockButton).toBeDisabled();

    await page.getByLabel('Encryption passphrase').fill('doc-passphrase');
    await expect(unlockButton).toBeEnabled();
  });

  test('second load with local encrypted data warns before switching to remote', async ({ page }) => {
    await page.goto('/');
    await seedEncryptedLocalDoc(page, 'password', { id: 'root', text: 'Secret Doc', children: [] });

    await page.reload();
    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Local');

    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: 'Remote' }).click();
    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Local');

    const stillHasData = await page.evaluate(() => !!localStorage.getItem('vmd_data_enc'));
    expect(stillHasData).toBe(true);

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Remote' }).click();
    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Remote');

    const clearedData = await page.evaluate(() => localStorage.getItem('vmd_data_enc'));
    expect(clearedData).toBeNull();
  });

  test('stale session preselects remote and prefills username only', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_username', 'stale@virgulas.com');
    });
    await page.goto('/');

    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Remote');
    await expect(page.getByLabel('Email')).toHaveValue('stale@virgulas.com');

    const unlockButton = page.getByRole('button', { name: 'Unlock' });
    await expect(unlockButton).toBeDisabled();

    await page.getByLabel('Account password').fill('account-password');
    await expect(unlockButton).toBeDisabled();

    await page.getByLabel('Encryption passphrase').fill('doc-passphrase');
    await expect(unlockButton).toBeEnabled();
  });

  test('first load can sign in before passphrase creation and switch to unlock for synced data', async ({ page }) => {
    await page.goto('/');

    const remoteDoc = await createEncryptedPayload(page, 'remote-passphrase', {
      id: 'root',
      text: 'Remote Root',
      children: [
        { id: 'child-1', text: 'Remote Child', children: [] }
      ]
    });

    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'local');
    });
    await installMockSupabase(page, { downloadData: remoteDoc });
    await page.reload();

    await page.getByRole('button', { name: 'Remote' }).click();
    await page.getByLabel('Email').fill('existing@virgulas.com');
    await page.getByLabel('Account password').fill('account-password');
    await page.getByLabel('Encryption passphrase').fill('remote-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();

    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await expect(page.locator('.status-mode')).toHaveText('Remote');
    await expect(page.locator('.status-user')).toHaveText('existing@virgulas.com');

    const storedSalt = await page.evaluate(() => {
      const value = localStorage.getItem('vmd_data_enc');
      if (!value) return null;
      const separatorIndex = value.indexOf('|');
      if (separatorIndex === -1) return null;
      return value.substring(0, separatorIndex);
    });
    expect(storedSalt).toBe(remoteDoc.salt);

    await expect(page.locator('.node-content').first()).toContainText('Remote Child');
  });

  test('valid remote session preselects remote and only needs passphrase to unlock', async ({ page }) => {
    await page.goto('/');

    const remoteDoc = await createEncryptedPayload(page, 'remote-passphrase', {
      id: 'root',
      text: 'Remote Root',
      children: [{ id: 'remote-1', text: 'From Server', children: [] }]
    });

    await page.evaluate(() => localStorage.clear());
    await installMockSupabase(page, { userEmail: 'valid@virgulas.com', downloadData: remoteDoc });
    await page.reload();

    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Remote');
    await expect(page.getByLabel('Email')).toHaveCount(0);
    await expect(page.getByLabel('Account password')).toHaveCount(0);
    await expect(page.getByLabel('Encryption passphrase')).toBeVisible();

    await page.getByLabel('Encryption passphrase').fill('remote-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();

    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await expect(page.locator('.node-content').first()).toContainText('From Server');
  });

  test('switching valid remote session to local signs out after confirmation', async ({ page }) => {
    await page.goto('/');

    const remoteDoc = await createEncryptedPayload(page, 'remote-passphrase', {
      id: 'root',
      text: 'Remote Root',
      children: [{ id: 'remote-2', text: 'Remote Data', children: [] }]
    });

    await page.evaluate(() => localStorage.clear());
    await installMockSupabase(page, { userEmail: 'valid@virgulas.com', downloadData: remoteDoc });
    await page.reload();

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Local' }).click();

    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Local');
    await expect(page.getByLabel('Create a passphrase')).toBeVisible();

    const stateAfterSwitch = await page.evaluate(() => ({
      hasLocalData: !!localStorage.getItem('vmd_data_enc')
    }));

    expect(stateAfterSwitch.hasLocalData).toBe(false);
  });

  test('unlock flow: existing user', async ({ page }) => {
    await page.goto('/');
    await seedEncryptedLocalDoc(page, 'password', {
      id: 'root',
      children: [{ id: 'child-1', text: 'Secret Doc', children: [] }]
    });

    await page.reload();

    // Check for "Unlock" screen
    await expect(page.getByRole('heading', { name: /Unlock Virgulas/i })).toBeVisible();
    await expect(page.getByLabel('Encryption passphrase')).toBeVisible();
    await expect(page.getByLabel('Create a passphrase')).toHaveCount(0);

    // Enter WRONG password
    await page.getByLabel('Encryption passphrase').fill('wrong-password');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText(/Invalid passphrase/i)).toBeVisible();

    // Enter CORRECT password
    await page.getByLabel('Encryption passphrase').fill('password');
    await page.getByRole('button', { name: 'Unlock' }).click();

    // Wait for main view to render
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');

    // Verify unlocked outline contains the expected first node text.
    const firstNodeText = await page.evaluate(async () => {
      const outline = (await import('/js/outline.js')).default;
      const root = outline.get('root');
      const firstChildId = root?.children.peek()?.[0];
      if (!firstChildId) return null;
      return outline.get(firstChildId)?.text.peek() || null;
    });
    expect(firstNodeText).toBe('Secret Doc');
  });

  test('login screen can sign up with mocked sync', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'local');
    });
    await installMockSupabase(page);
    await page.reload();

    await page.getByRole('button', { name: 'Remote' }).click();
    await page.getByLabel('Email').fill('mock-signup@virgulas.com');
    await page.getByLabel('Account password').fill('mock-password');
    await page.getByLabel('Encryption passphrase').fill('signup-passphrase');
    await page.getByRole('button', { name: 'Sign up' }).click();

    await expect(page.getByRole('button', { name: 'Unlock' })).toBeEnabled();
  });

  test('login screen shows auth provider errors in remote mode', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'local');
    });
    await installMockSupabase(page, { authErrorMessage: 'Invalid login credentials' });
    await page.reload();

    await page.getByRole('button', { name: 'Remote' }).click();
    await page.getByLabel('Email').fill('mock-error@virgulas.com');
    await page.getByLabel('Account password').fill('wrong-password');
    await page.getByLabel('Encryption passphrase').fill('doc-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();

    await expect(page.getByText('Invalid login credentials')).toBeVisible();
  });

  test('remote decrypt failure offers reset with new passphrase', async ({ page }) => {
    await page.goto('/');

    const remoteDoc = await createEncryptedPayload(page, 'old-passphrase', {
      id: 'root',
      text: 'Legacy Remote',
      children: []
    });

    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'local');
    });
    await installMockSupabase(page, { downloadData: remoteDoc });
    await page.reload();

    await page.getByRole('button', { name: 'Remote' }).click();
    await page.getByLabel('Email').fill('recover@virgulas.com');
    await page.getByLabel('Account password').fill('mock-password');
    await page.getByLabel('Encryption passphrase').fill('new-passphrase');
    await page.getByRole('button', { name: 'Unlock' }).click();

    await expect(page.getByText('Authenticated, but data could not be decrypted with this passphrase. You can reset remote data with a new passphrase.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset Remote Data With New Passphrase' })).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Reset Remote Data With New Passphrase' }).click();

    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await expect(page.locator('.node-content').first()).toContainText('Hello World');
  });

  test('selected unlock mode is remembered across reloads', async ({ page }) => {
    await installMockSupabase(page);
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'local');
    });
    await page.reload();

    await page.getByRole('button', { name: 'Remote' }).click();
    await page.reload();
    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Remote');

    await page.getByRole('button', { name: 'Local' }).click();
    await page.reload();
    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Local');
  });

  test('remembered filesystem mode is preselected when supported', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'filesystem');
    });

    await page.goto('/');

    const fileModeSupported = await page.evaluate(() => typeof (window as any).showOpenFilePicker === 'function');
    if (!fileModeSupported) {
      await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('Local');
      return;
    }

    await expect(page.locator('.auth-mode-btn.is-active')).toHaveText('File');
  });

  test('file mode shows unsupported API error when File System Access API is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'local');
      Object.defineProperty(window, 'showOpenFilePicker', {
        configurable: true,
        value: undefined
      });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'File' }).click();
    await expect(page.getByText('File System Access API is not supported in this browser.')).toBeVisible();
  });

  test('lock screen still renders when localStorage access throws', async ({ page }) => {
    await page.addInitScript(() => {
      const originalGetItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key: string) {
        if (String(key).startsWith('vmd_')) {
          throw new Error('Storage unavailable');
        }
        return originalGetItem.call(this, key);
      };
    });

    await page.goto('/');
    // When localStorage is broken, the app falls back gracefully to memory mode
    await expect(page.locator('#splash')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('#app')).toBeVisible();
  });

  test('rapid double submit only performs one unlock attempt', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'local');
    });
    await page.goto('/');

    await page.getByLabel('Create a passphrase').fill('double-submit-pass');

    await page.evaluate(async () => {
      const persistence = (await import('/js/persistence.js')).default as any;
      const originalUnlock = persistence.unlock.bind(persistence);
      let unlockCalls = 0;

      persistence.unlock = async (...args: any[]) => {
        unlockCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 120));
        return originalUnlock(...args);
      };

      (window as any).__unlockCallCount = () => unlockCalls;
    });

    const unlockButton = page.getByRole('button', { name: 'Unlock' });
    await Promise.allSettled([unlockButton.click(), unlockButton.click()]);

    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    const unlockCalls = await page.evaluate(() => (window as any).__unlockCallCount());
    expect(unlockCalls).toBe(1);
  });

  test('remote unlock applies URL hash zoom target', async ({ page }) => {
    await page.goto('/');

    const remoteDoc = await createEncryptedPayload(page, 'remote-passphrase', {
      id: 'root',
      text: 'Remote Root',
      children: [
        {
          id: 'remote-parent',
          text: 'Remote Parent',
          children: [{ id: 'remote-child', text: 'Remote Child', children: [] }]
        }
      ]
    });

    await page.evaluate(() => localStorage.clear());
    await installMockSupabase(page, { userEmail: 'valid@virgulas.com', downloadData: remoteDoc });
    await page.goto('about:blank');
    await page.goto('/#remote-parent');

    const unlockResult = await page.evaluate(async () => {
      const persistence = (await import('/js/persistence.js')).default as any;
      const outline = (await import('/js/outline.js')).default;
      const success = await persistence.unlock('remote-passphrase', { mode: 'remote', trustSession: true });
      return {
        success,
        zoomId: outline.zoomId.value,
        firstChildId: outline.get('remote-parent')?.children.peek()?.[0] || null
      };
    });

    expect(unlockResult.success).toBe(true);
    expect(unlockResult.zoomId).toBe('remote-parent');
    expect(unlockResult.firstChildId).toBe('remote-child');
  });

});

