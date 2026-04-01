let debug = new URLSearchParams(window.location.search).get('debug')

export function log(...args) {
    if (debug === 'true') {
        console.log('[debug]', ...args)
    }
}

export function enableDebug() {
    debug = 'true'
    log('Debug mode enabled')
    document.body.classList.add('debug')
}

if (debug) {
    enableDebug()
}

export const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);