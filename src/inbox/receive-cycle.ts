import type { MachineCommand } from '../campaigns/machine-store.ts'
import { ApiError } from '../store.ts'
import type { InboxReadMedia, MediaLookup } from './read.ts'

type ReceiveJob = {id:string; index:number; lease:string; lookup:MediaLookup}
export function createReceiveCycle(command:MachineCommand, load:InboxReadMedia) {
  return async () => {
    const job=await command<ReceiveJob|null>('claim',{})
    if (!job) return false
    const identity={id:job.id,index:job.index,lease:job.lease}
    try {
      const file=await load(job.lookup)
      if (file.base64.length > 11184812) throw new ApiError(413,'Medio demasiado grande para la caché.')
      await command('save',{...identity,mime:file.mime,base64:file.base64})
    } catch(error) {
      const permanent=error instanceof ApiError && [410,413,422].includes(error.status)
      await command('fail',{...identity,permanent})
    }
    return true
  }
}
