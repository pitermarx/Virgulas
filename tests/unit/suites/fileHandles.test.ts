import { describe, it, beforeEach } from 'bun:test'
import { fileHandleStore } from '../../../source/js/fileHandles.js'
import { installFakeIndexedDB } from '../indexedDbFake.js'
import { assertEqual } from '../testing.js'

function handleWithPermission(permission: 'granted' | 'denied') {
    return {
        name: 'notes.vmd',
        queryPermission: async () => permission,
        requestPermission: async () => permission,
        getFile: async () => ({ name: 'notes.vmd' })
    } as any
}

beforeEach(async () => {
    installFakeIndexedDB()
    await fileHandleStore.clear()
})

describe('fileHandleStore', () => {

    it('remembers, reopens and clears the last file', async () => {
        assertEqual(await fileHandleStore.hasSavedHandle(), false, 'nothing saved yet')

        await fileHandleStore.save(handleWithPermission('granted'))
        assertEqual(await fileHandleStore.hasSavedHandle(), true, 'the handle was remembered')
        assertEqual(await fileHandleStore.tryReopen(), true, 'the handle reopens')
        assertEqual(fileHandleStore.currentHandle()?.name, 'notes.vmd', 'the current handle is the reopened one')

        await fileHandleStore.clear()
        assertEqual(await fileHandleStore.hasSavedHandle(), false, 'clear removes the stored handle')
        assertEqual(fileHandleStore.currentHandle(), null, 'clear drops the current handle')
    })

    it('refuses to reopen a handle whose permission is denied', async () => {
        await fileHandleStore.save(handleWithPermission('denied'))
        assertEqual(await fileHandleStore.tryReopen(), false, 'denied permission falls back to the picker')
        assertEqual(fileHandleStore.currentHandle(), null, 'nothing is adopted')
    })

    it('reports no saved handle when nothing was stored', async () => {
        assertEqual(await fileHandleStore.hasSavedHandle(), false, 'no handle stored')
        assertEqual(await fileHandleStore.tryReopen(), false, 'nothing to reopen')
    })
})
