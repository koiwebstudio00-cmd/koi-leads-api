const kind = process.env.KOI_WORKER_KIND ?? 'campaign'
if (kind === 'chat') await import('./chat-worker.ts')
else if (kind === 'campaign') await import('./worker.ts')
else throw new Error('KOI_WORKER_KIND debe ser chat o campaign.')
export {}
