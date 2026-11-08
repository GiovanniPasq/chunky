import { useEffect, useSyncExternalStore } from 'react'
import type { Capabilities } from '../types'
import { capabilityService } from '../services/apiService'

type Snapshot = {
  caps: Capabilities | null
  loadState: 'loading' | 'ok' | 'error'
}

let snapshot: Snapshot = { caps: null, loadState: 'loading' }
let pending: Promise<void> | null = null
const listeners = new Set<() => void>()
const getSnapshot = () => snapshot
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function publish(next: Snapshot) {
  snapshot = next
  listeners.forEach(listener => listener())
}

function loadCapabilities() {
  if (snapshot.caps || pending) return
  publish({ caps: null, loadState: 'loading' })
  pending = capabilityService.get()
    .then(caps => publish({ caps, loadState: 'ok' }))
    .catch(() => publish({ caps: null, loadState: 'error' }))
    .finally(() => { pending = null })
}

/** Share capability labels, retries, and in-flight requests across controls. */
export function useCapabilities(enabled = true) {
  const state = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    if (enabled) loadCapabilities()
  }, [enabled])
  return { ...state, retry: loadCapabilities }
}
