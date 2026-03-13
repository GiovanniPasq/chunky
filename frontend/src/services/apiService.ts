import type { Capabilities } from '../types'

const BASE = '/api'

export const capabilityService = {
  async get(): Promise<Capabilities> {
    const res = await fetch(`${BASE}/capabilities`)
    if (!res.ok) throw new Error('Failed to fetch capabilities')
    return res.json()
  },
}
