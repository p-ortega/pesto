// @types/node is not one of this project's five approved frontend
// packages, so plain `.ts` files importing `node:fs`/`node:path`/`node:url`
// have no ambient types even though the vitest runtime (Node) resolves
// them fine. A `declare module` inside an ordinary `.ts` file that already
// has top-level imports is treated as module *augmentation* -- it must
// live in a global-script `.d.ts` file to declare a brand new module.
// Only what the source-scan test in theme.test.ts calls is declared here.

declare module 'node:fs' {
  export function readFileSync(filePath: string, encoding: string): string
}

declare module 'node:path' {
  export function dirname(filePath: string): string
  export function join(...segments: string[]): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string
}
