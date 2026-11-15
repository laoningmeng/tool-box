import type { BridgeApi } from '../shared/types'

declare global {
  interface Window {
    /** preload 通过 contextBridge 暴露的唯一入口 */
    api: BridgeApi
  }
}

export {}
