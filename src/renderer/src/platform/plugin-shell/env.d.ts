declare global {
  interface ImportMeta {
    glob(pattern: string, options?: { eager?: boolean }): Record<string, unknown>
  }

  interface Window {
    __navideTerminalSelection?: () => string
  }
}

export {}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
