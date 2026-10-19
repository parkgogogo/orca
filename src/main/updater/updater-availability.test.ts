import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ app: { isPackaged: true } }))
const toolkit = vi.hoisted(() => ({ is: { dev: false } }))
vi.mock('electron', () => electron)
vi.mock('@electron-toolkit/utils', () => toolkit)

const { updatesUnavailable } = await import('./updater-availability')

afterEach(() => {
  vi.unstubAllGlobals()
  electron.app.isPackaged = true
  toolkit.is.dev = false
})

describe('updatesUnavailable', () => {
  it('lets a packaged release build update', () => {
    vi.stubGlobal('ORCA_UPDATES_DISABLED', false)
    expect(updatesUnavailable()).toBe(false)
  })

  it('keeps a build with updates compiled out from ever updating', () => {
    vi.stubGlobal('ORCA_UPDATES_DISABLED', true)
    expect(updatesUnavailable()).toBe(true)
  })

  it('never updates unpackaged or dev runs', () => {
    vi.stubGlobal('ORCA_UPDATES_DISABLED', false)
    electron.app.isPackaged = false
    expect(updatesUnavailable()).toBe(true)
    electron.app.isPackaged = true
    toolkit.is.dev = true
    expect(updatesUnavailable()).toBe(true)
  })
})
