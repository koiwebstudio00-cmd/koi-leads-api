import { z } from 'zod'

export const maxInboxFileBytes = 8 * 1024 * 1024
const maxEncodedLength = Math.ceil(maxInboxFileBytes / 3) * 4
// Allow the maximum caption (including JSON escaping) in addition to the file.
export const inboxSendBodyLimit = maxEncodedLength + 65536

const mime = z.enum(['image/jpeg', 'image/png', 'application/pdf', 'audio/mpeg', 'audio/ogg',
  'audio/mp4', 'audio/wav', 'audio/webm', 'video/mp4', 'video/webm','text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
const file = z.object({
  name: z.string().trim().min(1).max(120).refine(name => !/[\\/\x00-\x1f\x7f]/.test(name)),
  mime,
  base64: z.string().min(4).max(maxEncodedLength),
  voiceNote: z.boolean().optional(),
}).strict()
export type InboxOutboundFile = z.infer<typeof file>

function validBytes(f: InboxOutboundFile): boolean {
  const bytes = Buffer.from(f.base64, 'base64')
  if (!bytes.length || bytes.length > maxInboxFileBytes || bytes.toString('base64') !== f.base64) return false
  const ascii = (start: number, end: number) => bytes.toString('ascii', start, end)
  if (f.voiceNote && (!['audio/ogg','audio/mp4','audio/webm'].includes(f.mime) || bytes.length>4*1024*1024)) return false
  if (f.mime==='audio/webm' && !f.voiceNote) return false
  switch (f.mime) {
    case 'text/plain': {
      if (bytes.includes(0)) return false
      try { new TextDecoder('utf-8',{fatal:true}).decode(bytes); return true } catch { return false }
    }
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
      const documentPart = f.mime.includes('wordprocessingml') ? 'word/document.xml'
        : f.mime.includes('spreadsheetml') ? 'xl/workbook.xml' : 'ppt/presentation.xml'
      // Office Open XML containers carry these filenames in their ZIP directory.
      return bytes.length >= 22 && bytes.readUInt32LE(0) === 0x04034b50
        && bytes.includes(Buffer.from('PK\x05\x06')) && bytes.includes(Buffer.from('[Content_Types].xml'))
        && bytes.includes(Buffer.from(documentPart)) && !bytes.includes(Buffer.from('vbaProject.bin'))
    }
    case 'audio/ogg': {
      if (ascii(0,4) !== 'OggS' || bytes[4] !== 0 || bytes[26] === undefined) return false
      const head = 27 + bytes[26]
      return ascii(head,head+8) === 'OpusHead' && (!f.voiceNote || bytes[head+9] === 1)
    }
    case 'image/jpeg': return bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex'))
    case 'image/png': return bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))
    case 'application/pdf': return ascii(0,5) === '%PDF-'
    case 'audio/mpeg': return ascii(0,3) === 'ID3' || (bytes[0] === 255 && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
    case 'audio/mp4':
    case 'video/mp4': return bytes.length >= 12 && ascii(4,8) === 'ftyp'
    case 'video/webm':
    case 'audio/webm': return bytes.subarray(0,4).equals(Buffer.from('1a45dfa3','hex')) && bytes.subarray(4,128).includes(Buffer.from('webm'))
    case 'audio/wav': return ascii(0,4) === 'RIFF' && ascii(8,12) === 'WAVE'
  }
}

export const inboxManualSendInput = z.object({
  text: z.string().trim().max(10000).default(''),
  attachment: file.refine(validBytes, 'El archivo no coincide con su formato.').optional(),
  quoteTo: z.uuid().optional(),
  sticker: z.literal('like_heart').optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.text && !value.attachment && !value.sticker)
    ctx.addIssue({ code: 'custom', message: 'Agregá un mensaje o un archivo.' })
  if (value.sticker && (value.text || value.attachment || value.quoteTo))
    ctx.addIssue({ code: 'custom', message: 'Enviá el sticker por separado.' })
})
