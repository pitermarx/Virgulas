// The autosave pipeline: one debounced write per mode, with a hard maximum wait
// so continuous typing cannot postpone the save, plus the teardown flush.
//
// It owns only timers and the "what was last written" bookkeeping. What a write
// means is the mode's store's job (`DocStore`), and the remote push is injected
// (`remoteSave.saveRemoteDocument`), so this module never sees ciphertext, keys
// or backend specifics. `persistence.ts` constructs it with the live stores.

import { effect } from '@preact/signals'
import outline from './outline.js'
import { StoreError, type DocStore } from './storage.js'
import type { OutlineDoc } from './docCodec.js'
import { log } from './utils.js'

export type SaveMode = 'local' | 'remote' | 'filesystem' | 'memory'

export interface SavePipelineDeps {
    /** Reactive reads: every `deps.*()` call inside the effect is tracked. */
    mode: () => SaveMode
    isUnlocked: () => boolean
    isFilesystemReady: () => boolean
    localStore: DocStore
    fileStore: () => DocStore | null
    setLocalSaveFailed: (failed: boolean) => void
    requestDurability: () => void
    saveRemote: (doc: OutlineDoc) => Promise<void>
    noteWriteActivity: () => void
    allowImmediateSync: () => void
}

const DEBOUNCE_MS = 1000
const MAX_WAIT_MS = 3000

export interface SavePipeline {
    /** Subscribes the effects. Returns a disposer (tests only). */
    install: () => () => void
    /** Flush pending work before lock/sign-out; false only when the remote push failed. */
    flush: () => Promise<boolean>
    /** Cancel the debounced save outright (teardown). */
    clear: () => void
    /** The document was just read from (or written to) a store: nothing to save yet. */
    markSaved: () => void
}

export function createSavePipeline(deps: SavePipelineDeps): SavePipeline {
    let lastTimeoutId: ReturnType<typeof setTimeout> | null = null
    let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
    let pendingSave: (() => void) | null = null
    let activeSave: (() => Promise<boolean>) | null = null
    let saveArmed = false
    let lastSavedVersion = -1

    function armMaxWaitSave() {
        if (maxWaitTimer !== null) return
        maxWaitTimer = setTimeout(() => {
            maxWaitTimer = null
            pendingSave?.()
        }, MAX_WAIT_MS)
    }

    function clearMaxWaitSave() {
        if (maxWaitTimer !== null) {
            clearTimeout(maxWaitTimer)
            maxWaitTimer = null
        }
    }

    function clear() {
        if (lastTimeoutId !== null) {
            clearTimeout(lastTimeoutId)
            lastTimeoutId = null
        }
        pendingSave = null
        clearMaxWaitSave()
    }

    async function flush(): Promise<boolean> {
        const save = activeSave
        if (!save) return true
        // Nothing armed and nothing changed since the last write: skip the round trip.
        if (!saveArmed && outline.version.peek() === lastSavedVersion) return true
        clear()
        deps.allowImmediateSync()
        return save()
    }

    /**
     * A load from the store (or an explicit write) is not an edit: record the
     * current version as saved and drop the timer the load's effect just armed.
     * Without this, every unlock re-encrypted and re-uploaded the document it
     * had only just read.
     */
    function markSaved() {
        lastSavedVersion = outline.version.peek()
        saveArmed = false
        clear()
    }

    function arm(save: () => Promise<boolean>) {
        activeSave = save
        saveArmed = true
        pendingSave = () => {
            if (lastTimeoutId) clearTimeout(lastTimeoutId)
            void save()
        }
        // Bound the debounce so continuous typing cannot postpone the write.
        if (outline.dirtyWrites.peek() > 0) armMaxWaitSave()
        lastTimeoutId = setTimeout(() => { void save() }, DEBOUNCE_MS)
    }

    function install() {
        const disposeActivity = effect(() => {
            if (deps.mode() !== 'remote') return
            if (outline.isDirty) deps.noteWriteActivity()
        })

        const disposeSave = effect(() => {
            const version = outline.version.value
            // `version` only advances after the outline's own 800 ms debounce, so
            // active typing would never arm a save. The raw write counter changes
            // on every mutation; subscribing to it arms the timer per keystroke.
            void outline.dirtyWrites.value
            const unlocked = deps.isUnlocked()
            const fsReady = deps.isFilesystemReady()
            const mode = deps.mode()

            let save: (() => Promise<boolean>) | null = null

            if (mode === 'memory') {
                // no persistence at all
            } else if (mode === 'filesystem' && fsReady) {
                // Plain VMD text, no encryption.
                save = async () => {
                    clearMaxWaitSave()
                    saveArmed = false
                    try {
                        const fileStore = deps.fileStore()
                        if (fileStore) await fileStore.write(outline.snapshot())
                        deps.setLocalSaveFailed(false)
                        log('[Persistence] Saved filesystem doc v' + version)
                    } catch (error) {
                        console.error('[Persistence] Filesystem write failed:', error)
                        deps.setLocalSaveFailed(true)
                    }
                    lastSavedVersion = version
                    return true
                }
            } else if (!unlocked) {
                log('Session locked, skipping encryption')
            } else if (mode === 'local') {
                // The encrypted slot store owns the data path; the KeySession
                // holds the secret, so this branch never handles ciphertext.
                save = async () => {
                    clearMaxWaitSave()
                    saveArmed = false
                    try {
                        await deps.localStore.write(outline.snapshot())
                        lastSavedVersion = version
                        deps.setLocalSaveFailed(false)
                        // The persist() prompt hangs off the capability, nowhere else.
                        if (deps.localStore.capabilities.durable === 'prompt') deps.requestDurability()
                        log('[Persistence] Saved encrypted doc v' + version)
                        return true
                    } catch (error) {
                        // data-06: a quota failure surfaces instead of dropping the save.
                        console.error('[Persistence] Error saving doc v' + version + ':', error)
                        if (error instanceof StoreError && error.code === 'too-large') deps.setLocalSaveFailed(true)
                        return false
                    }
                }
            } else {
                // Remote mode: local write then push, through the save orchestrator.
                save = async () => {
                    clearMaxWaitSave()
                    saveArmed = false
                    try {
                        const doc = outline.snapshot()
                        lastSavedVersion = version
                        await deps.saveRemote(doc)
                        log('[Persistence] Saved doc v' + version)
                        return true
                    } catch (error) {
                        console.error('[Persistence] Error saving doc v' + version + ':', error)
                        return false
                    }
                }
            }

            if (!save) {
                activeSave = null
                clearMaxWaitSave()
                return
            }
            arm(save)
            return () => {
                if (lastTimeoutId) clearTimeout(lastTimeoutId)
            }
        })

        return () => {
            disposeActivity()
            disposeSave()
        }
    }

    return { install, flush, clear, markSaved }
}
