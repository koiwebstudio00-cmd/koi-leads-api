// Coalesce signals, including notifications arriving before wait() is called.
export function createWakeup() {
  let pending = false
  let resume: (() => void) | undefined
  return {
    wake() { pending = true; resume?.() },
    wait(milliseconds: number, signal: AbortSignal): Promise<void> {
      if (pending || signal.aborted) { pending = false; return Promise.resolve() }
      return new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resume = undefined; pending = false; resolve() }
        const timer = setTimeout(done, milliseconds)
        resume = done
        signal.addEventListener('abort', done, { once: true })
        if (signal.aborted) done()
      })
    },
  }
}
