// Preloaded before every `bun test` file. Provides a DOM so the unit suites
// (markdown, shortcuts, ...) and the app modules that touch window/document can
// run in-process without a browser.
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })

// happy-dom's crypto may not expose WebCrypto's subtle API; keep Bun's.
if (!globalThis.crypto?.subtle) {
    // @ts-expect-error - assign Bun/Node WebCrypto implementation
    globalThis.crypto = (await import('node:crypto')).webcrypto
}
