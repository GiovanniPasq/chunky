import { describe, expect, it } from 'vitest'
import { isThemePreference, resolveTheme } from './theme'

describe('theme preferences', () => {
  it('follows the system only when the user selected system mode', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
  it('rejects corrupted or unsupported stored preferences', () => {
    for (const value of [null, '', 'sepia', {}, 1]) expect(isThemePreference(value)).toBe(false)
    for (const value of ['light', 'dark', 'system']) expect(isThemePreference(value)).toBe(true)
  })
})
