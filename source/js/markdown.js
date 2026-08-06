import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { isValidDueDate } from './meta.js'

const SAFE_HTTP_URL_RE = /^https?:\/\//i
const SEARCH_TOKEN_RE = /(^|[\s([{"'`])([#@][A-Za-z0-9_-]+)/g
const DUE_TOKEN_RE = /(^|\s)(due:\d{4}-\d{2}-\d{2})(\s*)$/

function isSafeHttpUrl(value) {
    if (!value) return false
    return SAFE_HTTP_URL_RE.test(String(value).trim())
}

function escapeAttribute(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function normalizeMarkdownAliases(text) {
    // SPEC accepts __Italic__ as emphasis.
    return String(text || '').replace(/__(.+?)__/g, '_$1_')
}

function shouldSkipTokenDecoration(node) {
    const parent = node?.parentElement
    if (!parent) return false
    return !!parent.closest('a, code, button, textarea, input')
}

function enforceExternalLinks(template) {
    const links = template.content.querySelectorAll('a[href]')
    for (const link of links) {
        const href = link.getAttribute('href')
        if (!isSafeHttpUrl(href)) continue
        link.setAttribute('target', '_blank')
        link.setAttribute('rel', 'noopener noreferrer')
    }
}

function replaceTextNodeWithSearchTokens(textNode) {
    const text = textNode.nodeValue || ''
    SEARCH_TOKEN_RE.lastIndex = 0
    let match = null
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

function decorateSearchTokens(safeHtml) {
    if (!safeHtml || typeof document === 'undefined') return safeHtml
    const template = document.createElement('template')
    template.innerHTML = safeHtml
    enforceExternalLinks(template)
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
    const candidates = []

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

function replaceTextNodeWithDueDates(textNode) {
    const text = textNode.nodeValue || ''
    const match = DUE_TOKEN_RE.exec(text)
    if (!match || !isValidDueDate(match[2].slice(4))) return null
    const prefix = match[1] || ''
    const token = match[2]
    const trailing = match[3] || ''
    const fragment = document.createDocumentFragment()
    if (match.index > 0) {
        fragment.append(document.createTextNode(text.slice(0, match.index)))
    }
    if (prefix) {
        fragment.append(document.createTextNode(prefix))
    }
    const span = document.createElement('span')
    span.className = 'due-date'
    span.textContent = token
    fragment.append(span)
    if (trailing) {
        fragment.append(document.createTextNode(trailing))
    }
    return fragment
}

function decorateDueDates(safeHtml) {
    if (!safeHtml || typeof document === 'undefined') return safeHtml
    const template = document.createElement('template')
    template.innerHTML = safeHtml
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
    const candidates = []

    while (walker.nextNode()) {
        const textNode = walker.currentNode
        if (shouldSkipTokenDecoration(textNode)) continue
        candidates.push(textNode)
    }

    for (const textNode of candidates) {
        const replacement = replaceTextNodeWithDueDates(textNode)
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

const SANITIZE_OPTIONS = {
    USE_PROFILES: { html: true },
    ALLOWED_TAGS: ['strong', 'em', 'a', 'img', 'code', 'br'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'rel']
}

export function renderInlineMarkdown(text, { decorateDueDate = false } = {}) {
    if (!text) return ''
    const rawHtml = markdown.parseInline(normalizeMarkdownAliases(text))
    const safeHtml = DOMPurify.sanitize(rawHtml, SANITIZE_OPTIONS)
    const decorated = decorateSearchTokens(safeHtml)
    return decorateDueDate ? decorateDueDates(decorated) : decorated
}
