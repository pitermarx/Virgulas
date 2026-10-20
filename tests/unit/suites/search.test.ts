import { describe, it, beforeEach } from 'bun:test'
import outline, { type SearchMatch } from '../../../source/js/outline.js'
import {
    searchQuery,
    searchResults,
    searchResultIndex,
    currentSearchMatchId,
    resetSearchNavigation,
    flatMatches,
    getFirstClosedParent
} from '../../../source/js/search.js'
import { assert, assertEqual } from '../testing.js'

beforeEach(() => {
    outline.reset()
    searchQuery.value = ''
    resetSearchNavigation()
})

function match(id: string, children: SearchMatch[] = [], isMatch = true): SearchMatch {
    return { id, text: id, children, isMatch }
}


describe('flatMatches', () => {

  it('flattens nested matches in document order', () => {
      const tree = match('root', [
          match('A', [match('A1'), match('A2')]),
          match('B', [match('B1')])
      ])
      assertEqual(flatMatches(tree).join(','), 'root,A,A1,A2,B,B1', 'depth-first order')
  })

  it('includes only nodes flagged as matches', () => {
      const tree = match('root', [
          match('A', [match('A1', [], false)]),
          match('B', [match('B1')], false)
      ], false)
      assertEqual(flatMatches(tree).join(','), 'A,B1', 'non-matching nodes are skipped')
  })

  it('returns an empty array when nothing matches', () => {
      const tree = match('root', [match('A', [], false)], false)
      assertEqual(flatMatches(tree).length, 0, 'no matches')
  })
})

describe('getFirstClosedParent', () => {

  it('returns null for empty or unknown ids', () => {
      assertEqual(getFirstClosedParent(null), null, 'null id')
      assertEqual(getFirstClosedParent('does-not-exist'), null, 'unknown id')
  })

  it('returns the node itself when it is collapsed', () => {
      const a = outline.addChild('root', { id: 'A', text: 'A' })!
      outline.addChild('A', { id: 'A1', text: 'A1' })
      a.open.value = false
      assertEqual(getFirstClosedParent('A1'), 'A', 'collapsed ancestor')
  })

  it('walks up through open ancestors to the collapsed one', () => {
      outline.addChild('root', { id: 'A', text: 'A' })!
      outline.addChild('A', { id: 'B', text: 'B' })!
      outline.addChild('B', { id: 'C', text: 'C' })!
      outline.get('A')!.open.value = false
      assertEqual(getFirstClosedParent('C'), 'A', 'skips open B')
  })

  it('falls back to root when every ancestor is open', () => {
      outline.addChild('root', { id: 'A', text: 'A' })!
      assertEqual(getFirstClosedParent('A'), 'root', 'root has no parent')
  })
})

describe('resetSearchNavigation', () => {

  it('resets index and current match id', () => {
      searchResultIndex.value = 4
      currentSearchMatchId.value = 'A'
      resetSearchNavigation()
      assertEqual(searchResultIndex.value, 0, 'index reset')
      assertEqual(currentSearchMatchId.value, null, 'current match cleared')
  })
})

describe('searchResults memo', () => {

  it('returns no results for an empty query', () => {
      outline.addChild('root', { id: 'A', text: 'alpha' })
      searchQuery.value = ''
      assertEqual(searchResults.value.tree, null, 'no tree without a query')
      assertEqual(searchResults.value.ids.length, 0, 'no ids without a query')
  })

  it('exposes ids that match the tree, in document order', () => {
      outline.addChild('root', { id: 'A', text: 'alpha one' })
      outline.addChild('root', { id: 'B', text: 'beta' })
      outline.addChild('root', { id: 'C', text: 'alpha two' })
      searchQuery.value = 'alpha'

      assertEqual(searchResults.value.ids.join(','), 'A,C', 'matching ids only')
      assertEqual(flatMatches(searchResults.value.tree!).join(','), 'A,C', 'ids agree with the tree')
  })

  it('matches case-insensitively and respects uppercase queries', () => {
      outline.addChild('root', { id: 'A', text: 'Alpha' })
      searchQuery.value = 'alpha'
      assertEqual(searchResults.value.ids.join(','), 'A', 'lowercase query matches mixed case')

      searchQuery.value = 'ALPHA'
      assertEqual(searchResults.value.ids.length, 0, 'uppercase query is case-sensitive')
  })

  it('matches on the description as well as the text', () => {
      outline.addChild('root', { id: 'A', text: 'title', description: 'needle in here' })
      searchQuery.value = 'needle'
      assertEqual(searchResults.value.ids.join(','), 'A', 'description is searchable')
  })

  it('memoizes one result per query instead of one per call', () => {
      outline.addChild('root', { id: 'A', text: 'alpha' })
      searchQuery.value = 'alpha'

      const first = searchResults.value
      const second = searchResults.value
      assert(first === second, 'repeated reads reuse the same object')
  })

  it('invalidates when the document changes', () => {
      outline.addChild('root', { id: 'A', text: 'alpha' })
      searchQuery.value = 'alpha'
      assertEqual(searchResults.value.ids.join(','), 'A', 'initial match')

      outline.addChild('root', { id: 'B', text: 'alpha too' })
      assertEqual(searchResults.value.ids.join(','), 'A,B', 'new match appears without re-setting the query')

      outline.updateNode('A', { text: 'changed' })
      assertEqual(searchResults.value.ids.join(','), 'B', 'edited node drops out')
  })

  it('invalidates after a structural reset', () => {
      outline.addChild('root', { id: 'A', text: 'alpha' })
      searchQuery.value = 'alpha'
      assertEqual(searchResults.value.ids.join(','), 'A', 'initial match')

      outline.reset()
      outline.addChild('root', { id: 'Z', text: 'alpha after reset' })
      assertEqual(searchResults.value.ids.join(','), 'Z', 'reset document is re-scanned')
  })
})