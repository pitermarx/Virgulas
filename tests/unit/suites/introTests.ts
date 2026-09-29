import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, createAsyncSectionHarness } from '../testing.js'

// Guards the in-app tour's authoring budgets. The tour is written to be *navigated*
// (short titles, two-line descriptions, detail one level down), so the copy has to
// stay inside the widths the layout actually gives it:
//
//   - a node is a single line: ~45 characters comfortably on mobile, ~70 on desktop
//   - a description previews two lines: ~50 characters per line on mobile (~100),
//     up to ~80 on desktop — anything longer is ellipsised until you zoom in

const harness = createAsyncSectionHarness({})
export const sections = harness.sections
const section = harness.section
const test = harness.test

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

section('Intro tour — authoring budgets')

await test('every node title fits on one line', () => {
    assert(items.length > 0, 'intro.vmd should contain nodes')
    for (const { text } of items) {
        const length = [...text].length
        assert(length <= TITLE_BUDGET, `title is ${length} chars (max ${TITLE_BUDGET}): "${text}"`)
    }
})

await test('every description line fits the two-line preview', () => {
    for (const text of descriptions) {
        const length = [...text].length
        assert(
            length <= DESCRIPTION_BUDGET,
            `description is ${length} chars (max ${DESCRIPTION_BUDGET}): "${text}"`
        )
    }
})

section('Intro tour — navigation-first content')

await test('the tour opens with the welcome node', () => {
    assert(
        items[0]?.text.includes('Welcome to Virgulas'),
        `first node should welcome the reader, found "${items[0]?.text}"`
    )
})

await test('the tour teaches zooming near the top', () => {
    const opening = items.slice(0, 6).map((i) => i.text).join(' | ')
    assert(/zoom/i.test(opening), `the first few nodes should invite zooming, found: ${opening}`)
})
