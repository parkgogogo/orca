import { app } from 'electron'
import { is } from '@electron-toolkit/utils'

/**
 * Whether this process may check for, download or install Orca releases.
 * Unpackaged and dev runs never update; neither does a build made with
 * updates compiled out (`ORCA_UPDATES_DISABLED`), such as a fork installed by
 * hand that the official release feed would otherwise replace.
 */
export function updatesUnavailable(): boolean {
  // Why typeof: a bundle that never defines the constant (helpers, tests) must not throw here.
  const compiledOut = typeof ORCA_UPDATES_DISABLED !== 'undefined' && ORCA_UPDATES_DISABLED
  return compiledOut || !app.isPackaged || is.dev
}
