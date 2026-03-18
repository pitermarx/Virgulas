// --- CRYPTO MODULE ---
export const AppCrypto = {
  PRF_EVAL_LABEL: 'virgulas-prf-v1',
  PRF_WRAPPED_KEY: 'vmd_prf_wrapped',
  PRF_ID_KEY: 'vmd_prf_id',
  PRF_DISABLED_KEY: 'vmd_prf_disabled',
  PRF_DISABLED_REASON_KEY: 'vmd_prf_disabled_reason',
  QUICK_UNLOCK_AUTO_TIMEOUT_MS: 8000,

  // Returns a random 16-byte salt, base64 encoded
  generateSalt: () => {
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes));
  },

  randomBytes: (size) => window.crypto.getRandomValues(new Uint8Array(size)),

  toBase64: (bytes) => btoa(String.fromCharCode(...bytes)),
  fromBase64: (base64) => Uint8Array.from(atob(base64), c => c.charCodeAt(0)),

  toBase64Url: (bytes) => AppCrypto.toBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, ''),

  fromBase64Url: (base64Url) => {
    const base64 = base64Url
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const padded = base64 + '==='.slice((base64.length + 3) % 4);
    return AppCrypto.fromBase64(padded);
  },

  getPrfEvalInput: () => new TextEncoder().encode(AppCrypto.PRF_EVAL_LABEL),

  isQuickUnlockLocallyDisabled: () => localStorage.getItem(AppCrypto.PRF_DISABLED_KEY) === '1',

  markQuickUnlockUnsupported: (reason = 'unknown') => {
    localStorage.setItem(AppCrypto.PRF_DISABLED_KEY, '1');
    localStorage.setItem(AppCrypto.PRF_DISABLED_REASON_KEY, reason);
  },

  clearQuickUnlockUnsupported: () => {
    localStorage.removeItem(AppCrypto.PRF_DISABLED_KEY);
    localStorage.removeItem(AppCrypto.PRF_DISABLED_REASON_KEY);
  },

  resetQuickUnlockLocalData: () => {
    localStorage.removeItem(AppCrypto.PRF_WRAPPED_KEY);
    localStorage.removeItem(AppCrypto.PRF_ID_KEY);
    AppCrypto.clearQuickUnlockUnsupported();
  },

  isQuickUnlockSupported: async () => {
    if (AppCrypto.isQuickUnlockLocallyDisabled()) return false;
    if (!window.PublicKeyCredential || !navigator.credentials) return false;

    if (typeof window.PublicKeyCredential.getClientCapabilities === 'function') {
      try {
        const capabilities = await window.PublicKeyCredential.getClientCapabilities();
        if (typeof capabilities.prf === 'boolean') return capabilities.prf;
      } catch (err) {
        console.warn('Failed to query WebAuthn capabilities', err);
      }
    }

    // Optimistic fallback: may support PRF via extension/bridge paths.
    return true;
  },

  deriveWrappingKeyFromPrf: async (prfFirstOutput) => {
    const material = prfFirstOutput instanceof Uint8Array ? prfFirstOutput : new Uint8Array(prfFirstOutput);
    const digest = await window.crypto.subtle.digest('SHA-256', material);
    return await window.crypto.subtle.importKey(
      'raw',
      digest,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  wrapPassphraseWithPrf: async (passphrase, prfFirstOutput) => {
    const key = await AppCrypto.deriveWrappingKeyFromPrf(prfFirstOutput);
    return await AppCrypto.encrypt(passphrase, key);
  },

  unwrapPassphraseWithPrf: async (wrappedPassphrase, prfFirstOutput) => {
    const key = await AppCrypto.deriveWrappingKeyFromPrf(prfFirstOutput);
    return await AppCrypto.decrypt(wrappedPassphrase, key);
  },

  getPrfOutput: async (credentialIdBytes, timeoutMs = 60000) => {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: AppCrypto.randomBytes(32),
        userVerification: 'preferred',
        timeout: timeoutMs,
        allowCredentials: [{
          id: credentialIdBytes,
          type: 'public-key'
        }],
        extensions: {
          prf: {
            eval: {
              first: AppCrypto.getPrfEvalInput()
            }
          }
        }
      }
    });

    if (!assertion || typeof assertion.getClientExtensionResults !== 'function') {
      throw new Error('Authenticator assertion missing extension results');
    }

    const extensionResults = assertion.getClientExtensionResults();
    const first = extensionResults?.prf?.results?.first;
    if (!first) {
      throw new Error('WebAuthn PRF output unavailable');
    }

    return first instanceof Uint8Array ? first : new Uint8Array(first);
  },

  registerQuickUnlock: async (passphrase) => {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: AppCrypto.randomBytes(32),
        rp: { name: 'Virgulas' },
        user: {
          id: AppCrypto.randomBytes(16),
          name: 'virgulas-user',
          displayName: 'Virgulas User'
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: {
          userVerification: 'preferred'
        },
        extensions: {
          prf: {
            eval: {
              first: AppCrypto.getPrfEvalInput()
            }
          }
        }
      }
    });

    if (!credential || !credential.rawId) {
      throw new Error('Passkey registration failed');
    }

    if (typeof credential.getClientExtensionResults !== 'function') {
      throw new Error('Passkey registration missing extension results');
    }

    // Use PRF output returned by create(); a follow-up get() can be unreliable.
    const extensionResults = credential.getClientExtensionResults();
    if (!extensionResults?.prf?.enabled) {
      throw new Error('PRF extension not supported or not enabled on this authenticator');
    }

    const prfFirst = extensionResults?.prf?.results?.first;
    if (!prfFirst) {
      throw new Error('WebAuthn PRF output unavailable during registration');
    }

    const credentialIdBytes = new Uint8Array(credential.rawId);
    const prfOutput = prfFirst instanceof Uint8Array ? prfFirst : new Uint8Array(prfFirst);
    const wrapped = await AppCrypto.wrapPassphraseWithPrf(passphrase, prfOutput);

    return {
      credentialId: AppCrypto.toBase64Url(credentialIdBytes),
      wrapped
    };
  },

  quickUnlockPassphrase: async (wrappedPassphrase, credentialId, options = {}) => {
    const credentialIdBytes = AppCrypto.fromBase64Url(credentialId);
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 60000;
    const prfOutput = await AppCrypto.getPrfOutput(credentialIdBytes, timeoutMs);
    return await AppCrypto.unwrapPassphraseWithPrf(wrappedPassphrase, prfOutput);
  },

  // Derives an AES-GCM key from a passphrase and salt using PBKDF2
  // 310,000 iterations, SHA-256, 256-bit output
  deriveKey: async (passphrase, saltBase64) => {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );

    // Convert salt from base64 back to Uint8Array
    const salt = Uint8Array.from(atob(saltBase64), c => c.charCodeAt(0));

    return await window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 310000,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false, // Key is not extractable
      ["encrypt", "decrypt"]
    );
  },

  // Encrypts text with AES-GCM-256
  // Returns base64 encoded string: IV (12 bytes) + Ciphertext
  encrypt: async (text, key) => {
    const enc = new TextEncoder();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encodedText = enc.encode(text);

    const ciphertext = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      key,
      encodedText
    );

    // Concatenate IV and Ciphertext
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);

    // Convert to base64
    return btoa(String.fromCharCode(...combined));
  },

  // Decrypts base64 encoded string with AES-GCM-256
  // Returns decrypted text
  decrypt: async (encryptedBase64, key) => {
    // Convert from base64 to Uint8Array
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

    // Extract IV (first 12 bytes) and Ciphertext
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    try {
      const decrypted = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        key,
        ciphertext
      );
      const dec = new TextDecoder();
      return dec.decode(decrypted);
    } catch (e) {
      console.error("Decryption failed:", e);
      throw new Error("Invalid password or corrupted data");
    }
  }
};
