import { afterEach, describe, it } from 'bun:test'
import { applyIntro, loadIntroDocument } from '../../../source/js/intro.js'
import outline from '../../../source/js/outline.js'
import { assertEqual } from '../testing.js'

const originalFetch = globalThis.fetch
afterEach(() => {
    globalThis.fetch = originalFetch
})

describe('intro loader', () => {

  it('loads the tour once and caches the fetch', async () => {
      let calls = 0
      globalThis.fetch = (async () => {
          calls++
          return new Response('- Hello\n', { status: 200 })
      }) as unknown as typeof fetch

      outline.reset()
      await loadIntroDocument()
      const children = outline.get('root')!.children.peek()
      assertEqual(children.length, 1, 'one tour node')
      assertEqual(outline.get(children[0])!.text.peek(), 'Hello', 'tour text loaded')

      await loadIntroDocument()
      assertEqual(calls, 1, 'the tour is fetched once per session')
  })

  it('falls back to one empty node when the tour is unavailable', () => {
      outline.reset()
      applyIntro('')
      assertEqual(outline.get('root')!.children.peek().length, 1, 'one empty node')
  })
})
