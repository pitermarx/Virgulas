import { test, expect, type Page, setupDoc, unlockApp, submitUnlock } from './test';

// ─── helpers ─────────────────────────────────────────────────────────────────

const openOptions = async (page: Page) => {
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByRole('heading', { name: 'Options' })).toBeVisible();
};

const closeOptions = async (page: Page) => {
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('heading', { name: 'Options' })).toHaveCount(0);
};

/** Mock Supabase client that also supports account `updateUser` calls. */
const installMockSupabase = async (
  page: Page,
  options: { userEmail?: string; downloadData?: { salt: string; data: string } | null } = {}
) => {
  await page.addInitScript(({ userEmail, downloadData }) => {
    const state: any = {
      serverRecord: downloadData ? { ...downloadData, updated_at: new Date().toISOString() } : null,
      updateCalls: [] as Array<Record<string, string>>
    };
    (window as any).__mockSupabaseState = state;

    const session: { user: { id: string; email: string } | null } = {
      user: userEmail ? { id: 'user-1', email: userEmail } : null
    };

    const queryBuilder = {
      select: () => queryBuilder,
      eq: () => queryBuilder,
      single: async () =>
        state.serverRecord
          ? { data: state.serverRecord, error: null }
          : { data: null, error: { code: 'PGRST116' } },
      upsert: async (payload: { salt: string; data: string; updated_at: string }) => {
        state.serverRecord = { salt: payload.salt, data: payload.data, updated_at: payload.updated_at };
        return { error: null };
      }
    };

    const client = {
      auth: {
        signInWithPassword: async ({ email }: { email: string }) => {
          session.user = { id: 'user-1', email };
          return { data: { user: session.user }, error: null };
        },
        signUp: async ({ email }: { email: string }) => {
          session.user = { id: 'user-1', email };
          return { data: { user: session.user }, error: null };
        },
        signOut: async () => {
          session.user = null;
          return { error: null };
        },
        getUser: async () => ({ data: { user: session.user }, error: null }),
        updateUser: async (payload: Record<string, string>) => {
          state.updateCalls.push(payload);
          return { data: { user: session.user }, error: null };
        }
      },
      from: () => queryBuilder
    };

    Object.defineProperty(window, 'supabase', {
      configurable: true,
      get: () => ({ createClient: () => client }),
      set: () => { }
    });

    localStorage.setItem('supabaseconfig', JSON.stringify({ url: 'http://127.0.0.1:54321', key: 'anon' }));
  }, options);
};

const createEncryptedPayload = async (page: Page, passphrase: string, doc: Record<string, unknown>) => {
  return await page.evaluate(async ({ passphrase, doc }: { passphrase: string; doc: any }) => {
    const { encrypt } = await import('/js/app.js' as string);
    const outline = (await import('/js/app.js' as string)).outline;
    outline.reset();
    const load = (children: any[], parentId: string) => {
      for (const child of children || []) {
        outline.addChild(parentId, { id: child.id, text: child.text });
        load(child.children || [], child.id);
      }
    };
    load(doc.children || [], 'root');
    const json = outline.serialize();
    const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
    const salt = btoa(String.fromCharCode(...saltBytes));
    return { salt, data: await encrypt(json, passphrase, salt) };
  }, { passphrase, doc });
};

const unlockRemote = async (page: Page, passphrase: string) => {
  await unlockApp(page, passphrase);
};

/** Stubs WebAuthn so `biometrics.enroll()` can run against real IndexedDB. */
const stubWebAuthn = (page: Page) =>
  page.addInitScript(() => {
    (window as any).PublicKeyCredential = function PublicKeyCredential() { };
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        create: async () => ({ rawId: new Uint8Array(16).buffer }),
        get: async () => ({ id: 'stub' }),
      },
    });
  });

/** Reads whether the device-local biometric seal (wrapped passphrase) is present. */
const readBiometricSeal = (page: Page) =>
  page.evaluate(() => new Promise<boolean>((resolve) => {
    const req = indexedDB.open('virgulas-biometric', 1);
    req.onerror = () => resolve(false);
    req.onsuccess = () => {
      try {
        const tx = req.result.transaction('kv', 'readonly');
        const get = tx.objectStore('kv').get('credential');
        get.onsuccess = () => resolve(!!get.result);
        get.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    };
  }));

// ─── tests ───────────────────────────────────────────────────────────────────

test.describe('Admin / Options modal', () => {
  test('exposes account info, biometric and data sections', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [{ id: '1', text: 'Node', children: [] }]
    });
    await openOptions(page);

    await expect(page.getByRole('heading', { name: 'Biometric unlock' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Quick capture' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Data' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export .vmd backup' })).toBeVisible();
    await expect(page.locator('#admin-inbox-node-name')).toBeVisible();
  });

  test('shows inline encryption details for the encrypted blob', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [{ id: '1', text: 'Node', children: [] }]
    });
    await openOptions(page);

    await expect(page.getByText('Blob', { exact: true })).toBeVisible();
    await expect(page.getByText(/AES-GCM-256/)).toBeVisible();
    await expect(page.getByText(/PBKDF2 600k/)).toBeVisible();
  });

  test('exports the current document as a .vmd download', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [{ id: '1', text: 'Export me', children: [] }]
    });
    await openOptions(page);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export .vmd backup' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^virgulas-\d{4}-\d{2}-\d{2}\.vmd$/);
    const stream = await download.createReadStream();
    let content = '';
    for await (const chunk of stream) content += chunk.toString();
    expect(content).toContain('Export me');

    await expect(page.getByText('Exported .vmd backup.')).toBeVisible();
  });

  test('imports a .vmd file and replaces the document', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [{ id: '1', text: 'Before import', children: [] }]
    });
    await openOptions(page);

    await page.locator('.admin-file-btn input[type="file"]').setInputFiles({
      name: 'backup.vmd',
      mimeType: 'text/plain',
      buffer: Buffer.from('- Imported A\n- Imported B\n')
    });

    await expect(page.getByText('Imported document. It will be re-encrypted and saved.')).toBeVisible();
    await closeOptions(page);

    await expect(page.locator('.node-content').first()).toContainText('Imported A');
    await expect(page.locator('.node-content').nth(1)).toContainText('Imported B');
  });

  test('changes the encryption passphrase and keeps the document decryptable', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [{ id: '1', text: 'Keep me', children: [] }]
    });
    await openOptions(page);

    await page.getByRole('button', { name: 'Change passphrase' }).click();
    await page.locator('#admin-passphrase').fill('new-passphrase-123');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Encryption passphrase changed. Data was re-encrypted.')).toBeVisible();

    // The old passphrase must no longer work, the new one must.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Unlock Virgulas' })).toBeVisible();
    await submitUnlock(page, 'password');
    await expect(page.getByText('Invalid passphrase.')).toBeVisible();

    await submitUnlock(page, 'new-passphrase-123');
    await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered');
    await expect(page.locator('.node-content').first()).toContainText('Keep me');
  });

  test('rejects an empty new passphrase', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [{ id: '1', text: 'Node', children: [] }]
    });
    await openOptions(page);

    await page.getByRole('button', { name: 'Change passphrase' }).click();
    await page.locator('#admin-passphrase').fill('');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('New passphrase cannot be empty.')).toBeVisible();
  });

  test('rejects a too-short new passphrase', async ({ page }) => {
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [{ id: '1', text: 'Node', children: [] }]
    });
    await openOptions(page);

    await page.getByRole('button', { name: 'Change passphrase' }).click();
    await page.locator('#admin-passphrase').fill('short');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Passphrase must be at least 10 characters.')).toBeVisible();
  });

  test('updates the account email through the remote sync client', async ({ page }) => {
    await page.goto('/');
    const remoteDoc = await createEncryptedPayload(page, 'remote-pass', {
      id: 'root',
      text: 'Remote Root',
      children: [{ id: 'r1', text: 'From Server', children: [] }]
    });
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'remote');
    });
    await installMockSupabase(page, { userEmail: 'valid@virgulas.com', downloadData: remoteDoc });
    await page.reload();
    await unlockRemote(page, 'remote-pass');

    await openOptions(page);
    await page.getByRole('button', { name: 'Change email' }).click();
    await page.locator('#admin-email').fill('new@virgulas.com');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Email updated. Confirm the change from the new address if required.')).toBeVisible();

    const calls = await page.evaluate(() => (window as any).__mockSupabaseState.updateCalls);
    expect(calls).toContainEqual({ email: 'new@virgulas.com' });
  });

  test('updates the account password through the remote sync client', async ({ page }) => {
    await page.goto('/');
    const remoteDoc = await createEncryptedPayload(page, 'remote-pass', {
      id: 'root',
      text: 'Remote Root',
      children: [{ id: 'r1', text: 'From Server', children: [] }]
    });
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'remote');
    });
    await installMockSupabase(page, { userEmail: 'valid@virgulas.com', downloadData: remoteDoc });
    await page.reload();
    await unlockRemote(page, 'remote-pass');

    await openOptions(page);
    await page.getByRole('button', { name: 'Change password' }).click();
    await page.locator('#admin-password').fill('brand-new-password');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Account password updated.')).toBeVisible();

    const calls = await page.evaluate(() => (window as any).__mockSupabaseState.updateCalls);
    expect(calls).toContainEqual({ password: 'brand-new-password' });
  });

  test('handleSignOut revokes the device biometric seal', async ({ page }) => {
    await stubWebAuthn(page);

    await page.goto('/');
    const remoteDoc = await createEncryptedPayload(page, 'remote-pass', {
      id: 'root',
      text: 'Remote Root',
      children: [{ id: 'r1', text: 'Secret note', children: [] }]
    });
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('vmd_last_mode', 'remote');
    });
    await installMockSupabase(page, { userEmail: 'valid@virgulas.com', downloadData: remoteDoc });
    await page.reload();
    await unlockRemote(page, 'remote-pass');

    await openOptions(page);
    await page.getByRole('button', { name: 'Enable on this device' }).click();
    await expect(page.getByText('Biometric unlock enabled on this device.')).toBeVisible();
    expect(await readBiometricSeal(page)).toBe(true);

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();

    // Sign-out lands in the in-memory demo; the seal must be gone. 
    await expect(page.locator('.status-memory-badge')).toBeVisible({ timeout: 5000 });
    await expect.poll(() => readBiometricSeal(page), { timeout: 5000 }).toBe(false);
  });

  test('purging local data revokes the device biometric seal', async ({ page }) => {
    await stubWebAuthn(page);
    await setupDoc(page, {
      id: 'root',
      text: 'Root',
      children: [{ id: '1', text: 'Node', children: [] }]
    });

    await openOptions(page);
    await page.getByRole('button', { name: 'Enable on this device' }).click();
    await expect(page.getByText('Biometric unlock enabled on this device.')).toBeVisible();
    expect(await readBiometricSeal(page)).toBe(true);

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Delete local data' }).click();

    await expect(page.locator('.status-memory-badge')).toBeVisible({ timeout: 5000 });
    await expect.poll(() => readBiometricSeal(page), { timeout: 5000 }).toBe(false);
  });
});
