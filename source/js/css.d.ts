// Bun extracts CSS imported from TypeScript at build time.
declare module '*.css' {
    const content: string
    export default content
}
