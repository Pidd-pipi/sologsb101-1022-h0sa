/**
 * 跨标签页通信：BroadcastChannel + 稳定 tabId + 在线心跳。
 * 同一浏览器的标签页共享同一个 IndexedDB，广播仅用于实时通知与在线状态；
 * 真正的冲突检测以「提交当刻读库」为准（见 collabStore）。
 */
import type { TabMessage, TabPresence } from '@/types/collab'

const CHANNEL_NAME = 'gbincense-tab'
const TAB_ID_KEY = 'gbincense:tab-id'
const HEARTBEAT_MS = 4000

function createTabId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `tab_${Date.now().toString(36)}${rand}`
}

/** 稳定的标签页身份：sessionStorage 同级标签页共享，关闭后失效 */
export const tabId: string = (() => {
  try {
    const existing = sessionStorage.getItem(TAB_ID_KEY)
    if (existing) return existing
    const id = createTabId()
    sessionStorage.setItem(TAB_ID_KEY, id)
    return id
  } catch {
    return createTabId()
  }
})()

function tabLabel(): string {
  return `标签页 ${tabId.slice(-6)}`
}

type MessageListener = (message: TabMessage) => void

class TabBus {
  private channel: BroadcastChannel | null = null
  private listeners = new Set<MessageListener>()
  readonly presence: TabPresence

  constructor() {
    this.presence = {
      tabId,
      label: tabLabel(),
      lastSeenAt: Date.now(),
      online: typeof navigator === 'undefined' ? true : navigator.onLine
    }
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME)
      this.channel.onmessage = (event: MessageEvent<TabMessage>) => this.dispatch(event.data)
    }
    if (typeof window !== 'undefined') {
      window.setInterval(() => this.beat(), HEARTBEAT_MS)
      window.addEventListener('beforeunload', this.handleUnload)
      window.addEventListener('online', this.handleOnline)
      window.addEventListener('offline', this.handleOffline)
    }
  }

  private dispatch(message: TabMessage): void {
    this.listeners.forEach((listener) => listener(message))
  }

  on(listener: MessageListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  broadcast(message: TabMessage): void {
    this.channel?.postMessage(message)
    // 同标签页内也派发一份，便于 store 统一监听
    this.dispatch(message)
  }

  private beat(): void {
    this.presence.lastSeenAt = Date.now()
    this.presence.online = typeof navigator === 'undefined' ? true : navigator.onLine
    this.broadcast({ type: 'presence', tab: { ...this.presence } })
  }

  private handleUnload = (): void => {
    this.broadcast({ type: 'bye', tabId })
  }

  private handleOnline = (): void => {
    this.presence.online = true
    this.broadcast({ type: 'hello', tab: { ...this.presence } })
  }

  private handleOffline = (): void => {
    this.presence.online = false
  }

  /** 主动宣告上线（应用启动 / 重连后调用） */
  hello(): void {
    this.broadcast({ type: 'hello', tab: { ...this.presence } })
  }
}

export const tabBus = new TabBus()
