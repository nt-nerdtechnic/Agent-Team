import { reactive } from 'vue'

const _ctx = reactive<Record<string, boolean | string>>({})

export function setContext(key: string, value: boolean | string): void {
  _ctx[key] = value
}

export function getContext(): Record<string, boolean | string> {
  return _ctx
}
