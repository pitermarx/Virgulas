import { test, expect } from './test';

test.describe('Encryption and Storage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Inject test utilities if not already exposed (we'll expose them in index.html)
  });

  test('generates valid salt', async ({ page }) => {
    const salt = await page.evaluate(() => window.App.crypto.generateSalt());
    expect(salt).toHaveLength(24); // base64 of 16 bytes is 24 chars
    expect(salt).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  test('derives key from passphrase and salt', async ({ page }) => {
    const key = await page.evaluate(async () => {
      const salt = window.App.crypto.generateSalt();
      const k = await window.App.crypto.deriveKey('password', salt);
      return k instanceof CryptoKey; // checking instance
    });
    expect(key).toBe(true);
  });

  test('encrypts and decrypts data', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const salt = window.App.crypto.generateSalt();
      const key = await window.App.crypto.deriveKey('password', salt);
      const original = 'Hello World';
      const encrypted = await window.App.crypto.encrypt(original, key);
      const decrypted = await window.App.crypto.decrypt(encrypted, key);
      return { original, decrypted, encryptedType: typeof encrypted };
    });
    expect(result.original).toBe(result.decrypted);
    expect(result.encryptedType).toBe('string');
  });

  test('storage stores encrypted data', async ({ page }) => {
    await page.evaluate(async () => {
      const salt = window.App.crypto.generateSalt();
      const key = await window.App.crypto.deriveKey('password', salt);
      await window.App.storage.set('test-key', 'secret-value', key);
    });

    // Check localStorage directly
    const stored = await page.evaluate(() => localStorage.getItem('test-key'));
    expect(stored).not.toBe('secret-value');
    expect(stored).not.toBeNull();
    
    // Check decrypt
    const retrieved = await page.evaluate(async () => {
       // Need to reconstruct key to decrypt (or just reuse if we kept it, but here we re-derive for realism)
       // Wait, we can't easily re-derive without the salt. 
       // In this test we just want to verify storage works with the key we have.
       // Let's reuse the key logic within evaluate for simplicity.
       const salt = window.App.crypto.generateSalt();
       const key = await window.App.crypto.deriveKey('password', salt);
       await window.App.storage.set('test-key', 'secret-value', key);
       return await window.App.storage.get('test-key', key);
    });
    expect(retrieved).toBe('secret-value');
  });
});
