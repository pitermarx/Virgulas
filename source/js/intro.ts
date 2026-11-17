// The in-app tour: one fetch/cache of `/intro.vmd` and the one way to load it
// into the live outline.
//
// Memory mode, the locked backdrop and the purge all reset the model to this
// text. Keeping it out of `persistence.ts` means the boot orchestration does not
// also own the tour asset.

import { vmdCodec } from './docCodec.js'
import outline from './outline.js'

let introVmdCache: string | null = null

/** The tour text, fetched once per session. Empty string when unavailable. */
export async function getIntroText(): Promise<string> {
    if (introVmdCache !== null) return introVmdCache
    try {
        const resp = await fetch('/intro.vmd', { cache: 'no-store' })
        if (resp.ok) {
            introVmdCache = await resp.text()
            return introVmdCache
        }
    } catch { /* ignore */ }
    introVmdCache = ''
    return introVmdCache
}

/** Reset the live model to the tour, or to one empty node when unavailable. */
export function applyIntro(introText: string) {
    outline.reset()
    if (introText && introText.trim()) {
        outline.loadDocument(vmdCodec.parse(introText))
    } else {
        outline.addChild('root', { text: '' })
    }
}

/** Reset the live model to the in-app tour (Memory mode and a purge). */
export async function loadIntroDocument() {
    applyIntro(await getIntroText())
}
