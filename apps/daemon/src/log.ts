export const log = {
  info: (msg: string, ...rest: unknown[]) => console.log(`[${stamp()}] ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`[${stamp()}] WARN ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`[${stamp()}] ERROR ${msg}`, ...rest),
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19)
}
