import { signal } from '@preact/signals';

// --- APP STATE ---
export const state = {
  status: signal('loading'), // 'loading' | 'setup' | 'unlock' | 'ready'
  viewMode: signal('outline'), // 'outline' | 'raw'
  theme: signal(localStorage.getItem('vmd_theme') || 'light'),
  key: signal(null),         // CryptoKey | null
  doc: signal(null),         // Object | null
  focusPath: signal(null),   // Array<number> | null
  focusField: signal('text'), // 'text' | 'description'
  error: signal(null),       // String | null
  isBusy: signal(false),
  history: signal([]),
  future: signal([]),
  searchQuery: signal(''),
  searchIdx: signal(0),      // Current search result index
  searchCurrentId: signal(null), // ID of currently highlighted search result
  zoomPath: signal([]),

  // Sync State
  user: signal(null),        // User | null
  syncStatus: signal('offline'), // 'offline' | 'syncing' | 'synced' | 'error'

  // Selection
  selection: signal([]),      // Array<Array<number>>

  // Quick unlock (WebAuthn PRF)
  quickUnlockSupported: signal(false),
  quickUnlockOfferVisible: signal(false),
  quickUnlockDismissedSession: signal(false),
  quickUnlockPassphrase: signal(null),
  quickUnlockError: signal(null),
  quickUnlockFallbackVisible: signal(false)
};
