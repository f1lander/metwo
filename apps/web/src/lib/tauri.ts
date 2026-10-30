// Thin bridge to the desktop shell. In a normal browser every call is a no-op.
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export interface DaemonProcess {
  readonly running: boolean
  readonly pid: number | null
  readonly startedAt: string | null
  readonly exitCode: number | null
  readonly root: string
  readonly external: boolean
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

export const desktop = {
  status: () => invoke<DaemonProcess>('daemon_status'),
  start: () => invoke<DaemonProcess>('daemon_start'),
  stop: () => invoke<DaemonProcess>('daemon_stop'),
  restart: () => invoke<DaemonProcess>('daemon_restart'),
  logs: () => invoke<readonly string[]>('daemon_logs'),
  setTray: (title: string) => (isDesktop ? invoke<void>('set_tray_title', { title }) : Promise.resolve()),
  open: (target: string) => (isDesktop ? invoke<void>('open_external', { target }) : Promise.resolve(void window.open(target, '_blank'))),
}
