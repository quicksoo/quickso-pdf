declare module 'file-saver' {
  export function saveAs(data: Blob | string | Uint8Array, filename?: string): void
}

declare module '*.mjs?url' {
  const src: string
  export default src
}
