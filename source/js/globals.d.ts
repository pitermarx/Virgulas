// Ambient declarations for globals injected at runtime or provided by newer
// browser APIs that are not yet in TypeScript's bundled DOM lib.

import type { createClient } from '@supabase/supabase-js'

declare global {
    /**
     * Build-time flag. `true` only in the Playwright test bundle (`bun run dev:test`);
     * production builds define it as `false`, so the test seam below is never read
     * by shipped code. See scripts/build-bun.mjs.
     */
    const __TEST_HOOKS__: boolean

    /**
     * Build-time KDF work divisor. `1` in production; the Playwright bundle
     * (`bun run dev:test`) defines it as a value greater than 1 so E2E setup and
     * unlock derive faster. The recorded envelope iteration count is unaffected.
     * See scripts/build-bun.mjs and source/js/crypto2.ts.
     */
    const __TEST_KDF_SCALE__: number

    interface Window {
        /**
         * Test-only seam for E2E specs. Read exclusively behind __TEST_HOOKS__ so a
         * same-origin script cannot substitute the Supabase client in production.
         */
        supabase?: { createClient: typeof createClient }
        /** Test hook: overrides the retry backoff base (ms). */
        __retryBaseMs?: number
        /** Set by the app to apply a URL-hash zoom target. */
        __applyHashZoomIfPresent?: (id?: string | null) => void
        /** Test hook exposing the unlock call counter. */
        __unlockCallCount?: number
        /** Test hook: overrides the sync poll interval (ms). */
        __syncPollIntervalMs?: number
        /** File System Access API (Chromium). */
        showOpenFilePicker?: (options?: {
            multiple?: boolean
            types?: Array<{ description?: string; accept: Record<string, string | string[]> }>
        }) => Promise<FileSystemFileHandle[]>
        showSaveFilePicker?: (options?: {
            suggestedName?: string
            types?: Array<{ description?: string; accept: Record<string, string | string[]> }>
        }) => Promise<FileSystemFileHandle>
    }

    interface FileSystemHandle {
        queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
        requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
    }

    interface FileSystemFileHandle {
        getFile(): Promise<File>
        createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>
    }

    interface FileSystemWritableFileStream extends WritableStream {
        write(data: string | BufferSource | Blob): Promise<void>
        close(): Promise<void>
    }
}

export {}
