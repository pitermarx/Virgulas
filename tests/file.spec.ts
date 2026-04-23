import { test, expect, type Page } from './test';

/**
 * Installs a mock File System Access API and a mock IndexedDB backend for
 * "virgulas-fs". Both persist across same-tab page reloads via sessionStorage.
 *
 * - window.showOpenFilePicker  → returns a fake handle for 'mock-file-1'
 * - window.showSaveFilePicker  → returns a fake handle for 'mock-file-new'
 * - indexedDB.open('virgulas-fs', 1) → fake IDB backed by sessionStorage
 *
 * The handle supports queryPermission / requestPermission / getFile / createWritable.
 * File content and write counts are stored in sessionStorage.__fsMockFiles (JSON).
 * The "saved handle" token is stored in sessionStorage.__fsHandleStore_last-file.
 *
 * Call window.__showOpenFilePickerCallCount to read how many times the picker was shown.
 */
const installMockFilesystem = async (page: Page, options: { initialContent?: string } = {}) => {
    await page.addInitScript(({ initialContent }: { initialContent: string }) => {
        // Restore persisted mock files from sessionStorage
        const savedFiles = sessionStorage.getItem('__fsMockFiles');
        (window as any).__fsMockFiles = savedFiles ? JSON.parse(savedFiles) : {};
        (window as any).__showOpenFilePickerCallCount = 0;

        function persistFiles() {
            sessionStorage.setItem('__fsMockFiles', JSON.stringify((window as any).__fsMockFiles));
        }

        // Seed the default file on first visit if not already present
        if (initialContent !== undefined && !(window as any).__fsMockFiles['mock-file-1']) {
            (window as any).__fsMockFiles['mock-file-1'] = { content: initialContent, writeCount: 0 };
            persistFiles();
        }

        const IDB_PREFIX = '__fsIDB_';

        function makeMockHandle(token: string): any {
            return {
                __token: token,
                kind: 'file',
                queryPermission: async () => 'granted',
                requestPermission: async () => 'granted',
                getFile: async () => ({
                    text: async () => {
                        const files = JSON.parse(sessionStorage.getItem('__fsMockFiles') || '{}');
                        return files[token]?.content ?? '';
                    }
                }),
                createWritable: async () => {
                    const chunks: string[] = [];
                    return {
                        write: async (data: string) => { chunks.push(data); },
                        close: async () => {
                            const files = JSON.parse(sessionStorage.getItem('__fsMockFiles') || '{}');
                            if (!files[token]) files[token] = { content: '', writeCount: 0 };
                            files[token].content = chunks.join('');
                            files[token].writeCount = (files[token].writeCount || 0) + 1;
                            sessionStorage.setItem('__fsMockFiles', JSON.stringify(files));
                            (window as any).__fsMockFiles = files;
                        }
                    };
                }
            };
        }

        (window as any).showOpenFilePicker = async () => {
            (window as any).__showOpenFilePickerCallCount++;
            const token = 'mock-file-1';
            const files = JSON.parse(sessionStorage.getItem('__fsMockFiles') || '{}');
            if (!files[token]) {
                files[token] = { content: '', writeCount: 0 };
                sessionStorage.setItem('__fsMockFiles', JSON.stringify(files));
            }
            return [makeMockHandle(token)];
        };

        (window as any).showSaveFilePicker = async () => {
            const token = 'mock-file-new';
            const files = JSON.parse(sessionStorage.getItem('__fsMockFiles') || '{}');
            files[token] = { content: '', writeCount: 0 };
            sessionStorage.setItem('__fsMockFiles', JSON.stringify(files));
            return makeMockHandle(token);
        };

        // Replace window.indexedDB with a fake backed by sessionStorage.
        // Patching IDBFactory.prototype.open is unreliable in Chromium because
        // the instance may have open() as an own property that shadows the prototype.
        const realIndexedDB = window.indexedDB;

        function makeFakeDb() {
            return {
                createObjectStore() { },
                transaction(_s: string, _m: string) {
                    const tx: any = { oncomplete: null };
                    tx.objectStore = () => ({
                        get(key: string) {
                            const req: any = {};
                            setTimeout(() => {
                                const stored = sessionStorage.getItem(IDB_PREFIX + key);
                                req.result = stored ? makeMockHandle(stored) : undefined;
                                if (req.onsuccess) req.onsuccess({ target: req });
                            }, 0);
                            return req;
                        },
                        put(handle: any, key: string) {
                            sessionStorage.setItem(IDB_PREFIX + key, handle.__token);
                            const req: any = {};
                            setTimeout(() => {
                                if (req.onsuccess) req.onsuccess({ target: req });
                                setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
                            }, 0);
                            return req;
                        },
                        delete(key: string) {
                            sessionStorage.removeItem(IDB_PREFIX + key);
                            const req: any = {};
                            setTimeout(() => {
                                if (req.onsuccess) req.onsuccess({ target: req });
                                setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
                            }, 0);
                            return req;
                        }
                    });
                    return tx;
                }
            };
        }

        const fakeIndexedDB = {
            open(name: string, _version: number) {
                if (name !== 'virgulas-fs') {
                    return realIndexedDB.open.call(realIndexedDB, name, _version);
                }
                const fakeDb = makeFakeDb();
                const req: any = {};
                setTimeout(() => {
                    req.result = fakeDb;
                    if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
                    if (req.onsuccess) req.onsuccess({ target: req });
                }, 0);
                return req;
            }
        };

        Object.defineProperty(window, 'indexedDB', {
            configurable: true,
            get() { return fakeIndexedDB; }
        });
    }, { initialContent: options.initialContent ?? '- Hello File World' });
};

test.describe('File mode', () => {
    test('opens a .vmd file and renders its content', async ({ page }) => {
        await installMockFilesystem(page, { initialContent: '- Hello File World' });
        await page.addInitScript(() => {
            localStorage.setItem('vmd_last_mode', 'filesystem');
        });

        await page.goto('/');
        await expect(page.locator('#splash')).toBeHidden({ timeout: 5000 });
        await expect(page.locator('.bottom-sheet')).toHaveAttribute('data-auth-mode', 'filesystem');

        await page.getByRole('button', { name: 'Unlock' }).click();

        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
        await expect(page.locator('.node-content').first()).toContainText('Hello File World');
        await expect(page.locator('.status-mode')).toHaveText('File');
    });

    test('writes changes to file after 1 second debounce', async ({ page }) => {
        await installMockFilesystem(page, { initialContent: '- Initial Node' });
        await page.addInitScript(() => {
            localStorage.setItem('vmd_last_mode', 'filesystem');
        });

        await page.goto('/');
        await expect(page.locator('#splash')).toBeHidden({ timeout: 5000 });
        await page.getByRole('button', { name: 'Unlock' }).click();
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });

        // Focus and edit the first node
        await page.locator('.node-text-md').first().click();
        const input = page.locator('.node-content input').first();
        await expect(input).toBeVisible({ timeout: 3000 });
        await input.fill('Edited Node');

        // Wait for the debounce to fire and content to be written — use poll so
        // the exact 1 s boundary doesn't matter.
        await expect.poll(
            () => page.evaluate(() => {
                const files = JSON.parse(sessionStorage.getItem('__fsMockFiles') || '{}');
                return files['mock-file-1']?.content ?? '';
            }),
            { timeout: 5000, intervals: [300] }
        ).toContain('Edited Node');

        // Sanity: write count incremented at least once
        const writeCountAfter = await page.evaluate(() => {
            const files = JSON.parse(sessionStorage.getItem('__fsMockFiles') || '{}');
            return files['mock-file-1']?.writeCount ?? 0;
        });
        expect(writeCountAfter).toBeGreaterThanOrEqual(1);
    });

    test('reopens last file via IndexedDB handle on reload without showing picker again', async ({ page }) => {
        await installMockFilesystem(page, { initialContent: '- Persistent Node' });
        await page.addInitScript(() => {
            localStorage.setItem('vmd_last_mode', 'filesystem');
        });

        // First load: open the file (saves handle to mock IDB via sessionStorage)
        await page.goto('/');
        await expect(page.locator('#splash')).toBeHidden({ timeout: 5000 });
        await page.getByRole('button', { name: 'Unlock' }).click();
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
        await expect(page.locator('.node-content').first()).toContainText('Persistent Node');

        const pickerCallsAfterFirstOpen = await page.evaluate(() => (window as any).__showOpenFilePickerCallCount);
        expect(pickerCallsAfterFirstOpen).toBe(1);

        // Reload: tryReopen() should find the handle in IDB and not call showOpenFilePicker
        await page.reload();
        await expect(page.locator('#splash')).toBeHidden({ timeout: 5000 });
        await page.getByRole('button', { name: 'Unlock' }).click();
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });
        await expect(page.locator('.node-content').first()).toContainText('Persistent Node');

        const pickerCallsAfterReload = await page.evaluate(() => (window as any).__showOpenFilePickerCallCount);
        expect(pickerCallsAfterReload).toBe(0); // addInitScript resets this to 0 on each load
        // The handle was found in IDB (sessionStorage), so picker was never called on this load
    });

    test('falls back to file picker when stored handle permission is denied', async ({ page }) => {
        // Seed a handle in the mock IDB whose queryPermission always returns 'denied',
        // then verify that unlockFilesystem() falls through to showOpenFilePicker.
        await page.addInitScript(({ initialContent }: { initialContent: string }) => {
            // Restore any files from a previous navigation (same session)
            const savedFiles = sessionStorage.getItem('__fsMockFiles');
            (window as any).__fsMockFiles = savedFiles ? JSON.parse(savedFiles) : {};
            (window as any).__showOpenFilePickerCallCount = 0;

            function persistFiles() {
                sessionStorage.setItem('__fsMockFiles', JSON.stringify((window as any).__fsMockFiles));
            }

            const IDB_PREFIX = '__fsIDB_';

            // The handle stored in IDB always reports permission denied
            function makeDeniedHandle(token: string): any {
                return {
                    __token: token,
                    kind: 'file',
                    queryPermission: async () => 'denied',
                    requestPermission: async () => 'denied',
                    getFile: async () => ({ text: async () => '' }),
                    createWritable: async () => ({ write: async () => { }, close: async () => { } })
                };
            }

            function makeGrantedHandle(token: string): any {
                return {
                    __token: token,
                    kind: 'file',
                    queryPermission: async () => 'granted',
                    requestPermission: async () => 'granted',
                    getFile: async () => ({
                        text: async () => {
                            const files = JSON.parse(sessionStorage.getItem('__fsMockFiles') || '{}');
                            return files[token]?.content ?? '';
                        }
                    }),
                    createWritable: async () => {
                        const chunks: string[] = [];
                        return {
                            write: async (data: string) => { chunks.push(data); },
                            close: async () => {
                                const files = JSON.parse(sessionStorage.getItem('__fsMockFiles') || '{}');
                                if (!files[token]) files[token] = { content: '', writeCount: 0 };
                                files[token].content = chunks.join('');
                                files[token].writeCount = (files[token].writeCount || 0) + 1;
                                sessionStorage.setItem('__fsMockFiles', JSON.stringify(files));
                                (window as any).__fsMockFiles = files;
                            }
                        };
                    }
                };
            }

            // Pre-seed the picker target file
            if (!(window as any).__fsMockFiles['mock-file-picker']) {
                (window as any).__fsMockFiles['mock-file-picker'] = { content: initialContent, writeCount: 0 };
                persistFiles();
            }

            // Pre-store a denied handle in the fake IDB so tryReopen() finds it
            sessionStorage.setItem(IDB_PREFIX + 'last-file', 'mock-file-denied');

            // showOpenFilePicker returns a fully-granted handle for a different token
            (window as any).showOpenFilePicker = async () => {
                (window as any).__showOpenFilePickerCallCount++;
                const token = 'mock-file-picker';
                const files = JSON.parse(sessionStorage.getItem('__fsMockFiles') || '{}');
                if (!files[token]) {
                    files[token] = { content: initialContent, writeCount: 0 };
                    sessionStorage.setItem('__fsMockFiles', JSON.stringify(files));
                }
                return [makeGrantedHandle(token)];
            };

            const realIndexedDB = window.indexedDB;
            function makeFakeDb() {
                return {
                    createObjectStore() { },
                    transaction(_s: string, _m: string) {
                        const tx: any = { oncomplete: null };
                        tx.objectStore = () => ({
                            get(key: string) {
                                const req: any = {};
                                setTimeout(() => {
                                    const stored = sessionStorage.getItem(IDB_PREFIX + key);
                                    // Return the denied handle for the stored token
                                    req.result = stored ? makeDeniedHandle(stored) : undefined;
                                    if (req.onsuccess) req.onsuccess({ target: req });
                                }, 0);
                                return req;
                            },
                            put(handle: any, key: string) {
                                sessionStorage.setItem(IDB_PREFIX + key, handle.__token);
                                const req: any = {};
                                setTimeout(() => {
                                    if (req.onsuccess) req.onsuccess({ target: req });
                                    setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
                                }, 0);
                                return req;
                            },
                            delete(key: string) {
                                sessionStorage.removeItem(IDB_PREFIX + key);
                                const req: any = {};
                                setTimeout(() => {
                                    if (req.onsuccess) req.onsuccess({ target: req });
                                    setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
                                }, 0);
                                return req;
                            }
                        });
                        return tx;
                    }
                };
            }
            const fakeIndexedDB = {
                open(name: string, _version: number) {
                    if (name !== 'virgulas-fs') return realIndexedDB.open.call(realIndexedDB, name, _version);
                    const fakeDb = makeFakeDb();
                    const req: any = {};
                    setTimeout(() => {
                        req.result = fakeDb;
                        if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
                        if (req.onsuccess) req.onsuccess({ target: req });
                    }, 0);
                    return req;
                }
            };
            Object.defineProperty(window, 'indexedDB', { configurable: true, get() { return fakeIndexedDB; } });
        }, { initialContent: '- Fallback Node' });

        await page.addInitScript(() => { localStorage.setItem('vmd_last_mode', 'filesystem'); });

        await page.goto('/');
        await expect(page.locator('#splash')).toBeHidden({ timeout: 5000 });

        // Unlock: tryReopen finds the denied handle, falls back to showOpenFilePicker
        await page.getByRole('button', { name: 'Unlock' }).click();
        await expect(page.locator('body')).toHaveAttribute('data-main-view', 'rendered', { timeout: 5000 });

        // The picker was invoked exactly once (fallback path)
        const pickerCalls = await page.evaluate(() => (window as any).__showOpenFilePickerCallCount);
        expect(pickerCalls).toBe(1);

        // Content from the picker-opened file is rendered
        await expect(page.locator('.node-content').first()).toContainText('Fallback Node');
    });
});
