import { describe, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert } from '../testing.js'

// Guards the in-app tour's authoring budgets. The tour is written to be *navigated*
// (short titles, two-line descriptions, detail one level down), so the copy has to
// stay inside the widths the layout actually gives it:
//
//   - a node is a single line: ~45 characters comfortably on mobile, ~70 on desktop
//   - a description previews two lines: ~50 characters per line on mobile (~100),
//     up to ~80 on desktop — anything longer is ellipsised until you zoom in
//
// The "Write with light markdown" node is the one deliberate exception: it carries
// a block-markdown description that is meant to be read by zooming in, so its
// budget is enforced per line (each still fits a line) rather than as a whole.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const intro = readFileSync(path.join(ROOT, 'source/intro.vmd'), 'utf8')

const TITLE_BUDGET = 45
const DESCRIPTION_BUDGET = 100

const itemPattern = /^(\s*)([-+])\s(\[[ xX]\]\s)?(.*)$/
const lines = intro.split(/\r?\n/)

const items = lines
    .map((line) => line.match(itemPattern))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ text: m[4] }))

const descriptions = lines
    .filter((line) => line.trim() && !itemPattern.test(line))
    .map((line) => line.trim())


describe('Intro tour — authoring budgets', () => {

  it('every node title fits on one line', () => {
      assert(items.length > 0, 'intro.vmd should contain nodes')
      for (const { text } of items) {
          const length = [...text].length
          assert(length <= TITLE_BUDGET, `title is ${length} chars (max ${TITLE_BUDGET}): "${text}"`)
      }
  })

  it('every description line fits the two-line preview', () => {
      for (const text of descriptions) {
          const length = [...text].length
          assert(
              length <= DESCRIPTION_BUDGET,
              `description is ${length} chars (max ${DESCRIPTION_BUDGET}): "${text}"`
          )
      }
  })
})

describe('Intro tour — navigation-first content', () => {

  it('the tour opens with the welcome node', () => {
      assert(
          items[0]?.text.includes('Welcome to Virgulas'),
          `first node should welcome the reader, found "${items[0]?.text}"`
      )
  })

  it('the tour teaches zooming near the top', () => {
      const opening = items.slice(0, 6).map((i) => i.text).join(' | ')
      assert(/zoom/i.test(opening), `the first few nodes should invite zooming, found: ${opening}`)
  })
})

describe('Intro tour — markdown demo', () => {

  it('includes a full block-markdown description for the zoomed view', () => {
      assert(intro.includes('## Headings, lists, quotes'), 'demo should show a heading')
      assert(intro.includes('> Quotes set a passage apart.'), 'demo should show a blockquote')
      assert(intro.includes('```'), 'demo should show a fenced code block')
      assert(intro.includes('| Markdown | Renders |'), 'demo should show a table')
  })
})