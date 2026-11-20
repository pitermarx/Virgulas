import { afterEach, beforeEach, describe, it } from 'bun:test'
import persistence from '../../../source/js/persistence.js'
import outline from '../../../source/js/outline.js'
import { store } from '../../../source/js/utils.js'
import { fileHandleStore } from '../../../source/js/fileHandles.js'
import { assertEqual } from '../testing.js'

// One live state (`sessionState`) instead of sessionUnlocked + filesystemReady +
// memoryReady. The point of the collapse is that "locked" and "a mode is live"
// can no longer disagree; these assertions exercise the transitions the lock
// screen, the save pipeline and Options read.

const originalFetch = globalThis.fetch
beforeEach(() => {
    // The intro fetch has nothing to reach in the unit DOM; the app falls back
    // to one empty node, which is all these transitions need.
    globalThis.fetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
})
afterEach(() => {
    globalThis.fetch = originalFetch
})

describe('session state', () => {

  it('memory is one live state, and locking returns to locked', async () => {
      persistence.reset()
      assertEqual(persistence.isLocked(), true, 'starts locked')
      assertEqual(persistence.isMemory(), false, 'not in memory while locked')

      await persistence.unlock('', { mode: 'memory' })
      assertEqual(persistence.isLocked(), false, 'memory opens the session')
      assertEqual(persistence.isMemory(), true, 'memory is the live mode')

      await persistence.lock()
      assertEqual(persistence.isLocked(), true, 'locking returns to locked')
      assertEqual(persistence.isMemory(), false, 'memory is no longer live')
  })

  it('reset lands in locked, and memory can be booted again', async () => {
      persistence.reset()
      await persistence.unlock('', { mode: 'memory' })
      persistence.reset()
      assertEqual(persistence.isLocked(), true, 'reset locks the session')

      await persistence.bootMemoryAfterWipe()
      assertEqual(persistence.isLocked(), false, 'memory boot unlocks')
      assertEqual(persistence.isMemory(), true, 'memory boot is live')
  })

  it('the locked backdrop never overwrites a live session', async () => {
      // The backdrop is fetched while the app boots; a fast unlock can land
      // before the fetch resolves. Loading the tour then would reset the live
      // document and drop the URL hash zoom target (the Firefox race).
      persistence.reset()
      await persistence.unlock('', { mode: 'memory' })
      outline.addChild('root', { text: 'keep me' })
      const live = outline.getVMD('root')

      await persistence.loadLockedBackgroundIntro()
      assertEqual(outline.getVMD('root'), live, 'a live document is untouched')
  })

  it('Move to File storage writes the document, switches the mode and clears the local copy', async () => {
      persistence.reset()
      await persistence.unlock('', { mode: 'memory' })
      outline.addChild('root', { text: 'move me' })
      // A stale local copy that the move must clear without a confirm: the
      // destination file already holds the document by then.
      store.data.set('salt|stale-local-copy')

      const written: string[] = []
      const fakeHandle = {
          name: 'moved.vmd',
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          getFile: async () => ({ name: 'moved.vmd', text: async () => written.join('') }),
          createWritable: async () => ({ write: async (text: string) => { written.push(text) }, close: async () => { } })
      } as any
      ;(globalThis as any).showOpenFilePicker = () => { }
      ;(globalThis as any).showSaveFilePicker = async () => fakeHandle

      try {
          assertEqual(await persistence.moveToFilesystem(), true, 'the move completes without a confirm dialog')
      } finally {
          delete (globalThis as any).showOpenFilePicker
          delete (globalThis as any).showSaveFilePicker
      }

      assertEqual(persistence.getMode(), 'filesystem', 'the session is live in File mode')
      assertEqual(persistence.isLocked(), false, 'no lock-screen round trip')
      assertEqual(written.join('').includes('move me'), true, 'the live document reached the file')
      assertEqual(store.data.get(), null, 'the local copy is cleared')
      assertEqual(fileHandleStore.currentHandle()?.name, 'moved.vmd', 'the destination is the current file')
      assertEqual(outline.getVMD('root').includes('move me'), true, 'the document stays live')
  })
})
