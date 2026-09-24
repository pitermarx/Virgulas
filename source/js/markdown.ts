import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { isValidDueDate } from './meta.js'

const SAFE_HTTP_URL_RE = /^https?:\/\//i
const SEARCH_TOKEN_RE = /(^|[\s([{"'`])([#@][A-Za-z0-9_-]+)/g
const DUE_TOKEN_TEXT_RE = /^due:(\d{4}-\d{2}-\d{2})$/
const REC_TOKEN_TEXT_RE = /^rec:\d*(?:y|m|w|d)$/
const META_TOKEN_PART = '(?:due:\\d{4}-\\d{2}-\\d{2}|rec:\\d*(?:y|m|w|d))'
// Matches one or two trailing due:/rec: tokens (in either order) at the end of the text
const META_TOKEN_RE = new RegExp(`(^|\\s)(${META_TOKEN_PART}(?:\\s+${META_TOKEN_PART})?)(\\s*)$`)

function isSafeHttpUrl(value: unknown) {
    if (!value) return false
    return SAFE_HTTP_URL_RE.test(String(value).trim())
}

function escapeAttribute(value: unknown) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function normalizeMarkdownAliases(text: string) {
    // SPEC accepts __Italic__ as emphasis.
    return String(text || '').replace(/__(.+?)__/g, '_$1_')
}

function shouldSkipTokenDecoration(node: Node) {
    const parent = node?.parentElement
    if (!parent) return false
    return !!parent.closest('a, code, button, textarea, input')
}

function enforceExternalLinks(template: HTMLTemplateElement) {
    const links = template.content.querySelectorAll('a[href]')
    for (const link of links) {
        const href = link.getAttribute('href')
        if (!isSafeHttpUrl(href)) continue
        link.setAttribute('target', '_blank')
        link.setAttribute('rel', 'noopener noreferrer')
    }
}

// Hardens images that survive sanitisation. Images still load normally (SPEC), but
// they must not leak the app URL as a referrer. The sanitizer already strips
// event handlers, `srcset`, and inline styles; here we also drop any `src` that is
// not http(s) or a same-origin relative path (no `javascript:`, `data:`, or
// protocol-relative URLs).
function isSafeImageSrc(value: unknown) {
    if (!value) return false
    const src = String(value).trim()
    if (isSafeHttpUrl(src)) return true
    // Relative URL: no scheme and not protocol-relative.
    return !src.startsWith('//') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)
}

function hardenImages(template: HTMLTemplateElement) {
    const images = template.content.querySelectorAll('img')
    for (const image of images) {
        if (!isSafeImageSrc(image.getAttribute('src'))) {
            image.remove()
            continue
        }
        image.setAttribute('referrerpolicy', 'no-referrer')
        image.setAttribute('loading', 'lazy')
        image.setAttribute('decoding', 'async')
    }
}

function replaceTextNodeWithSearchTokens(textNode: Node) {
    const text = textNode.nodeValue || ''
    SEARCH_TOKEN_RE.lastIndex = 0
    let match: RegExpExecArray | null = null
    let lastIndex = 0
    let found = false
    const fragment = document.createDocumentFragment()

    while ((match = SEARCH_TOKEN_RE.exec(text)) !== null) {
        found = true
        const fullMatch = match[0]
        const prefix = match[1] || ''
        const token = match[2]
        const matchIndex = match.index

        if (matchIndex > lastIndex) {
            fragment.append(document.createTextNode(text.slice(lastIndex, matchIndex)))
        }
        if (prefix) {
            fragment.append(document.createTextNode(prefix))
        }

        const tokenButton = document.createElement('button')
        tokenButton.type = 'button'
        tokenButton.className = token.startsWith('#')
            ? 'search-token-inline search-token-tag'
            : 'search-token-inline search-token-mention'
        tokenButton.setAttribute('data-search-token', token)
        tokenButton.textContent = token
        fragment.append(tokenButton)

        lastIndex = matchIndex + fullMatch.length
    }

    if (!found) return null
    if (lastIndex < text.length) {
        fragment.append(document.createTextNode(text.slice(lastIndex)))
    }
    return fragment
}

function decorateSearchTokens(safeHtml: string) {
    if (!safeHtml || typeof document === 'undefined') return safeHtml
    const template = document.createElement('template')
    template.innerHTML = safeHtml
    enforceExternalLinks(template)
    hardenImages(template)
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
    const candidates: Node[] = []

    while (walker.nextNode()) {
        const textNode = walker.currentNode
        if (shouldSkipTokenDecoration(textNode)) continue
        candidates.push(textNode)
    }

    for (const textNode of candidates) {
        const replacement = replaceTextNodeWithSearchTokens(textNode)
        if (!replacement || !textNode.parentNode) continue
        textNode.parentNode.replaceChild(replacement, textNode)
    }

    return template.innerHTML
}

// Builds a chip span for a single due: or rec: token, or null if invalid (e.g. bad calendar date).
function chipForToken(token: string): HTMLElement | null {
    const dueMatch = DUE_TOKEN_TEXT_RE.exec(token)
    if (dueMatch) {
        if (!isValidDueDate(dueMatch[1])) return null
        const span = document.createElement('span')
        span.className = 'due-date'
        span.textContent = token
        return span
    }
    if (REC_TOKEN_TEXT_RE.test(token)) {
        const span = document.createElement('span')
        span.className = 'rec-badge'
        span.textContent = token
        return span
    }
    return null
}

function replaceTextNodeWithMetaChips(textNode: Node) {
    const text = textNode.nodeValue || ''
    const match = META_TOKEN_RE.exec(text)
    if (!match) return null
    const rawChips = match[2].split(/\s+/).map(chipForToken)
    if (rawChips.some(chip => !chip)) return null
    const chips = rawChips as HTMLElement[]
    const prefix = match[1] || ''
    const trailing = match[3] || ''
    const fragment = document.createDocumentFragment()
    if (match.index > 0) {
        fragment.append(document.createTextNode(text.slice(0, match.index)))
    }
    if (prefix) {
        fragment.append(document.createTextNode(prefix))
    }
    chips.forEach((chip, i) => {
        if (i > 0) fragment.append(document.createTextNode(' '))
        fragment.append(chip)
    })
    if (trailing) {
        fragment.append(document.createTextNode(trailing))
    }
    return fragment
}

function decorateMetaChips(safeHtml: string) {
    if (!safeHtml || typeof document === 'undefined') return safeHtml
    const template = document.createElement('template')
    template.innerHTML = safeHtml
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
    const candidates: Node[] = []

    while (walker.nextNode()) {
        const textNode = walker.currentNode
        if (shouldSkipTokenDecoration(textNode)) continue
        candidates.push(textNode)
    }

    for (const textNode of candidates) {
        const replacement = replaceTextNodeWithMetaChips(textNode)
        if (!replacement || !textNode.parentNode) continue
        textNode.parentNode.replaceChild(replacement, textNode)
    }

    return template.innerHTML
}

const markdown = new Marked({
    async: false,
    gfm: true,
    breaks: false
})

markdown.use({
    renderer: {
        link(token) {
            const href = isSafeHttpUrl(token.href) ? token.href : '#'
            const body = this.parser.parseInline(token.tokens)
            const title = token.title ? ` title="${escapeAttribute(token.title)}"` : ''
            return `<a href="${escapeAttribute(href)}"${title} target="_blank" rel="noopener noreferrer">${body}</a>`
        },
        image(token) {
            if (!isSafeHttpUrl(token.href)) {
                return escapeAttribute(token.text || '')
            }
            const alt = escapeAttribute(token.text || '')
            const src = escapeAttribute(token.href)
            const title = token.title ? ` title="${escapeAttribute(token.title)}"` : ''
            return `<img src="${src}" alt="${alt}"${title}>`
        }
    }
})

// NOTE: do not add USE_PROFILES here. DOMPurify merges ALLOWED_TAGS/ALLOWED_ATTR
// with a profile instead of replacing it, which silently widens the allow-list to
// the whole HTML profile (form, input, style, class, id, ...). Keep the explicit
// allow-list as the single source of truth. Exported so a regression test can
// assert the profile is never reintroduced.
export const SANITIZE_OPTIONS: any = {
    ALLOWED_TAGS: ['strong', 'em', 'a', 'img', 'code', 'br'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title']
}
export function renderInlineMarkdown(text: string, { decorateMeta = false }: { decorateMeta?: boolean } = {}) {
    if (!text) return ''
    const rawHtml = markdown.parseInline(normalizeMarkdownAliases(text))
    const safeHtml = DOMPurify.sanitize(rawHtml as string, SANITIZE_OPTIONS) as unknown as string
    const decorated = decorateSearchTokens(safeHtml)
    return decorateMeta ? decorateMetaChips(decorated) : decorated
}
