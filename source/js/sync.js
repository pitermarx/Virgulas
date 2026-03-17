import { state } from './state.js';
import { storage } from './storage.js';
import { AppCrypto } from './crypto.js';

// --- SYNC MODULE ---
export const AppSync = {
  client: null,
  conflictCallback: null,

  init: () => {
    try {
      const configEl = document.querySelector('script[type="virgulas-config"]');
      if (configEl) {
        const config = JSON.parse(configEl.textContent);
        if (config.supabaseUrl && config.supabaseAnonKey &&
          config.supabaseUrl !== '%%SUPABASE_URL%%') {
          // Assuming supabase is available globally via CDN script in index.html
          if (window.supabase) {
            AppSync.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
            console.log('Supabase initialized');
          } else {
            console.error('Supabase library not loaded');
          }
        } else {
          console.log('Supabase config missing or placeholder');
        }
      }
    } catch (e) {
      console.error('Failed to init Supabase', e);
    }
  },

  signIn: async (email, password) => {
    if (!AppSync.client) throw new Error('Sync not configured');
    const { data, error } = await AppSync.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  signUp: async (email, password) => {
    if (!AppSync.client) throw new Error('Sync not configured');
    const { data, error } = await AppSync.client.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  },

  signOut: async () => {
    if (!AppSync.client) return;
    await AppSync.client.auth.signOut();
  },

  getUser: async () => {
    if (!AppSync.client) return null;
    const { data: { user } } = await AppSync.client.auth.getUser();
    return user;
  },

  refreshSession: async () => {
    if (!AppSync.client) {
      state.user.value = null;
      state.syncStatus.value = 'offline';
      return null;
    }

    const user = await AppSync.getUser();
    state.user.value = user;
    state.syncStatus.value = user ? 'synced' : 'offline';
    return user;
  },

  syncAfterUnlock: async (localDoc, localKey) => {
    if (!AppSync.client) {
      state.user.value = null;
      state.syncStatus.value = 'offline';
      return { success: true, action: 'none' };
    }

    const user = await AppSync.getUser();
    state.user.value = user;

    if (!user) {
      state.syncStatus.value = 'offline';
      return { success: true, action: 'none' };
    }

    if (!localDoc || !localKey) {
      state.syncStatus.value = 'synced';
      return { success: true, action: 'none' };
    }

    state.syncStatus.value = 'syncing';
    const result = await AppSync.checkAndSync(localDoc, localKey);

    if (!result.success) {
      if (result.action === 'conflict_pending') {
        state.syncStatus.value = 'error';
      } else {
        state.syncStatus.value = navigator.onLine ? 'error' : 'offline';
      }
      return result;
    }

    if (result.action === 'applied_server' && result.data) {
      state.doc.value = result.data;
      await storage.set('vmd_data', result.data, localKey);
    }

    state.syncStatus.value = 'synced';
    return result;
  },

  // Compare local vs server timestamps and handle conflicts
  checkAndSync: async (localDoc, localKey) => {
    if (!AppSync.client) return { success: true, action: 'none' };

    try {
      const serverData = await AppSync.download();
      if (!serverData) {
        // No server data, upload local
        const encryptedData = await AppCrypto.encrypt(JSON.stringify(localDoc), localKey);
        const salt = storage.getSalt();
        await AppSync.upload(encryptedData, salt);
        return { success: true, action: 'uploaded_local' };
      }

      // Parse server timestamp
      const serverTimestamp = new Date(serverData.updated_at);
      const localTimestamp = new Date(localDoc.updated_at || Date.now());

      if (localTimestamp > serverTimestamp) {
        // Local is newer, upload silently
        const encryptedData = await AppCrypto.encrypt(JSON.stringify(localDoc), localKey);
        await AppSync.upload(encryptedData, serverData.salt);
        return { success: true, action: 'uploaded_local' };
      } else if (serverTimestamp > localTimestamp) {
        // Server is newer, prompt user
        if (AppSync.conflictCallback) {
          const choice = await AppSync.conflictCallback(serverData, localDoc);
          if (choice === 'server') {
            // Apply server data
            const decryptedServerData = await AppCrypto.decrypt(serverData.data, localKey);
            const parsedServerData = JSON.parse(decryptedServerData);
            return { success: true, action: 'applied_server', data: parsedServerData };
          } else if (choice === 'local') {
            // Upload local data
            const encryptedData = await AppCrypto.encrypt(JSON.stringify(localDoc), localKey);
            await AppSync.upload(encryptedData, serverData.salt);
            return { success: true, action: 'uploaded_local' };
          }
        }
        return { success: false, action: 'conflict_pending' };
      } else {
        // Timestamps are equal, no action needed
        return { success: true, action: 'none' };
      }
    } catch (error) {
      console.error('Sync check failed:', error);
      return { success: false, action: 'error', error };
    }
  },

  // Upload local data to server (encrypted)
  upload: async (encryptedData, salt) => {
    if (!AppSync.client) return;
    const user = await AppSync.getUser();
    if (!user) return;

    const { error } = await AppSync.client
      .from('outlines')
      .upsert({
        user_id: user.id,
        salt: salt,
        data: encryptedData,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

    if (error) throw error;
  },

  // Download data from server
  download: async () => {
    if (!AppSync.client) return null;
    const user = await AppSync.getUser();
    if (!user) return null;

    const { data, error } = await AppSync.client
      .from('outlines')
      .select('salt, data, updated_at')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 is "no rows"
    return data;
  },

  // Trigger background upload on write operations, with exponential backoff retry
  triggerBackgroundUpload: async (doc, key) => {
    if (!AppSync.client) return;
    const maxRetries = 3;
    let delay = 1000;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const encryptedData = await AppCrypto.encrypt(JSON.stringify(doc), key);
        const salt = storage.getSalt();
        await AppSync.upload(encryptedData, salt);
        state.syncStatus.value = 'synced';
        return;
      } catch (error) {
        console.error(`Background upload failed (attempt ${attempt + 1}):`, error);
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
        } else {
          state.syncStatus.value = 'error';
        }
      }
    }
  }
};
