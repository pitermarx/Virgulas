// a11y-03: the sync indicator must not rely on hue alone, and every state
// colour must reach 3:1 against the surface it sits on (WCAG 1.4.11).
// The values are read from source/css/base.css so the tokens cannot drift.
import { describe, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert } from '../testing.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const css = readFileSync(path.join(ROOT, 'source/css/base.css'), 'utf8')
const ui = readFileSync(path.join(ROOT, 'source/js/ui.ts'), 'utf8')

function blockText(selector: string): string {
    const start = css.indexOf(selector)
    assert(start >= 0, `base.css must define ${selector}`)
    const open = css.indexOf('{', start)
    const close = css.indexOf('\n}', open)
    assert(open >= 0 && close > open, `base.css must close ${selector}`)
    return css.slice(open + 1, close)
}

function tokens(text: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const match of text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) out[match[1]] = match[2]
    return out
}

function channel(value: number): number {
    const s = value / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

function luminance(hex: string): number {
    const n = hex.replace('#', '')
    const r = parseInt(n.slice(0, 2), 16)
    const g = parseInt(n.slice(2, 4), 16)
    const b = parseInt(n.slice(4, 6), 16)
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: string, b: string): number {
    const la = luminance(a)
    const lb = luminance(b)
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
    return (hi + 0.05) / (lo + 0.05)
}

const light = tokens(blockText(':root {'))
const dark = { ...light, ...tokens(blockText('[data-theme="dark"] {')) }

describe('sync indicator contrast and shape (a11y-03)', () => {
    const themes = [['light', light], ['dark', dark]] as const

    for (const [name, theme] of themes) {
        for (const token of ['color-synced', 'color-syncing', 'color-offline', 'color-danger']) {
            it(`${token} reaches 3:1 on the ${name} background`, () => {
                const ratio = contrast(theme[token], theme['color-background'])
                assert(ratio >= 3, `${token} is ${ratio.toFixed(2)}:1 on the ${name} background, needs 3:1`)
            })
        }

        it(`faint text reaches 4.5:1 on the ${name} surface`, () => {
            const ratio = contrast(theme['color-text-faint'], theme['color-surface'])
            assert(ratio >= 4.5, `text-faint is ${ratio.toFixed(2)}:1 on the ${name} surface, needs 4.5:1`)
        })
    }

    it('every sync state has its own glyph, not just a colour', () => {
        for (const state of ['synced', 'syncing', 'unsynced', 'offline']) {
            assert(ui.includes(`case '${state}':`), `syncIcon must draw the ${state} state`)
        }
        assert(ui.includes('SYNC_LABELS'), 'the indicator needs a visible state label')
        assert(ui.includes('aria-hidden="true">${label}'), 'the visible label must not be read twice')
        assert(ui.includes('role="status"'), 'the live region must stay for screen readers')
    })
})
