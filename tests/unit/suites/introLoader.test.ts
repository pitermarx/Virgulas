import { describe, it } from 'bun:test'
import { applyIntro } from '../../../source/js/intro.js'
import outline from '../../../source/js/outline.js'
import { assertEqual } from '../testing.js'

describe('intro loader', () => {

  it('loads the tour into the model', () => {
      outline.reset()
      applyIntro('- Hello\n')
      const children = outline.get('root')!.children.peek()
      assertEqual(children.length, 1, 'one tour node')
      assertEqual(outline.get(children[0])!.text.peek(), 'Hello', 'tour text loaded')
  })

  it('falls back to one empty node when the tour is unavailable', () => {
      outline.reset()
      applyIntro('')
      assertEqual(outline.get('root')!.children.peek().length, 1, 'one empty node')
  })
})
