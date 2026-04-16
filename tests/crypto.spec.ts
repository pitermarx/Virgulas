import { test, expect } from './test';

test.describe('Encryption and Storage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('encrypts/decrypts with passphrase and salt', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { encrypt, decrypt } = await import('/js/crypto2.js');
      const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
      const salt = btoa(String.fromCharCode(...saltBytes));
      const original = 'Hello World';
      const encrypted = await encrypt(original, 'password', salt);
      const decrypted = await decrypt(encrypted, 'password', salt);
      return { original, decrypted, encryptedType: typeof encrypted, salt };
    });
    expect(result.original).toBe(result.decrypted);
    expect(result.encryptedType).toBe('string');
    expect(result.salt).toHaveLength(24); // base64 of 16 bytes is 24 chars
    expect(result.salt).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  test('decryption fails with wrong passphrase', async ({ page }) => {
    const failed = await page.evaluate(async () => {
      const { encrypt, decrypt } = await import('/js/crypto2.js');
      const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
      const salt = btoa(String.fromCharCode(...saltBytes));
      const encrypted = await encrypt('secret', 'password', salt);
      try {
        await decrypt(encrypted, 'wrong-password', salt);
        return false;
      } catch {
        return true;
      }
    });
    expect(failed).toBe(true);
  });

  test('encrypts and decrypts data', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { encrypt, decrypt } = await import('/js/crypto2.js');
      const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
      const salt = btoa(String.fromCharCode(...saltBytes));
      const original = 'Hello World';
      const encrypted = await encrypt(original, 'password', salt);
      const decrypted = await decrypt(encrypted, 'password', salt);
      return { original, decrypted, encryptedType: typeof encrypted };
    });
    expect(result.original).toBe(result.decrypted);
    expect(result.encryptedType).toBe('string');
  });

  test('storage stores encrypted data', async ({ page }) => {
    await page.evaluate(async () => {
      const { encrypt } = await import('/js/crypto2.js');
      const saltBytes = window.crypto.getRandomValues(new Uint8Array(16));
      const salt = btoa(String.fromCharCode(...saltBytes));
      const encrypted = await encrypt('secret-value', 'password', salt);
      localStorage.setItem('test-key', `${salt}|${encrypted}`);
    });

    // Check localStorage directly
    const stored = await page.evaluate(() => localStorage.getItem('test-key'));
    expect(stored).not.toBe('secret-value');
    expect(stored).not.toBeNull();

    // Check decrypt
    const retrieved = await page.evaluate(async () => {
      const { decrypt } = await import('/js/crypto2.js');
      const value = localStorage.getItem('test-key');
      if (!value) {
        return null;
      }
      const separatorIndex = value.indexOf('|');
      if (separatorIndex === -1) {
        return null;
      }
      const salt = value.substring(0, separatorIndex);
      const encrypted = value.substring(separatorIndex + 1);
      return await decrypt(encrypted, 'password', salt);
    });
    expect(retrieved).toBe('secret-value');
  });
});
