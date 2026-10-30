import { describe, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert } from '../testing.js'

// The splash node's removal is driven from app.ts, which no unit test runs
// (importing the module boots the app). These pin the CSS contract the removal
// relies on: the fade stays visible for its full duration, and the faded splash
// leaves the visible tree even before app.ts drops the node — opacity alone
// stays "visible" to Playwright and to assistive tech.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const baseCss = () =>
    readFileSync(path.join(ROOT, 'source/css/base.css'), 'utf8').replace(/\s+/g, ' ')

describe('Splash visibility', () => {

    it('a hidden splash is invisible, not only transparent', () => {
        assert(
            /#splash\.hidden \{[^}]*visibility: hidden;/.test(baseCss()),
            '#splash.hidden must set visibility: hidden so a faded splash is not visible'
        )
    })

    it('the visibility step waits for the end of the fade', () => {
        assert(
            /#splash \{[^}]*transition: opacity 0\.7s var\(--ease-base\), visibility 0s linear 0\.7s;/.test(baseCss()),
            '#splash must delay visibility by the fade duration so the fade is not cut short'
        )
    })
})
