import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { IMPORT_LIMITS, prepareRows, type ImportDraft, type ParsedImport } from './contracts/imports.ts'
import type { ParseOptions } from './import-parser.ts'
import { ApiError } from './store.ts'

export const parseOptionsSchema = z.object({
  filename: z.string().min(1).max(200).regex(/\.(csv|xlsx)$/i),
  sheet: z.coerce.number().int().min(1).max(20).default(1), headerRow: z.coerce.number().int().min(1).max(100).default(1),
  delimiter: z.enum(['', ',', ';', '\t', '|']).default(''), encoding: z.enum(['utf-8', 'windows-1252']).default('utf-8'),
}).strict()
const column = z.number().int().min(0).max(IMPORT_LIMITS.columns - 1).nullable()
const rowKey = z.string().regex(/^[1-9]\d{0,4}$/)
const consent = z.object({ state: z.enum(['unknown', 'granted', 'denied']), evidence: z.string().max(1000) }).strict()
export const choicesSchema = z.object({
  revision:z.number().int().nonnegative().default(0),
  mapping: z.object({ phone: column, name: column, company: column, email: column, source: column }).strict(),
  country: z.enum(['AR', 'international']), trim: z.boolean(),
  edits: z.record(rowKey, z.array(z.string().max(IMPORT_LIMITS.cellLength)).max(IMPORT_LIMITS.columns)),
  consents: z.record(rowKey, consent), selected: z.array(z.number().int().positive()).max(IMPORT_LIMITS.rows),
  target: z.union([z.object({ listId: z.uuid() }).strict(), z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500) }).strict()]),
}).strict()

export function validateDraftChoices(draft: ImportDraft, input: unknown) {
  const choices = choicesSchema.parse(input)
  const indices = Object.values(choices.mapping).filter(index => index !== null)
  if (indices.some(index => index >= draft.headers.length)) throw new ApiError(422,'Una columna asignada no existe en el archivo.')
  const sourceIds = new Set(draft.rows.map(row => row.row))
  if (new Set(choices.selected).size !== choices.selected.length || choices.selected.some(row => !sourceIds.has(row)) || [...Object.keys(choices.edits), ...Object.keys(choices.consents)].some(key => !sourceIds.has(Number(key)))) throw new ApiError(422, 'La selección no coincide con las filas del archivo.')
  if (Object.values(choices.edits).some(cells => cells.length !== draft.headers.length)) throw new ApiError(422, 'Una fila editada tiene una cantidad de columnas distinta al archivo.')
  return choices
}
export function prepareCommit(draft: ImportDraft, input: unknown) {
  const choices = validateDraftChoices(draft,input)
  const indices = Object.values(choices.mapping).filter(index => index !== null)
  if (choices.mapping.phone === null || new Set(indices).size !== indices.length) throw new ApiError(422, 'Asigná una columna de teléfono y no repitas columnas entre campos.')
  if (!choices.selected.length) throw new ApiError(422,'Seleccioná al menos una fila.')
  const selected = new Set(choices.selected)
  const rows = prepareRows(draft, choices).map(row => ({ ...row, selected: selected.has(row.row) }))
  const invalid = rows.find(row => row.selected && row.error)
  if (invalid) throw new ApiError(422, `Fila ${invalid.row}: ${invalid.error} Corregila o desmarcala.`)
  const payload = { target: choices.target, rows, choices }
  if (Buffer.byteLength(JSON.stringify(payload)) > 20_000_000) throw new ApiError(422,'Los datos preparados superan 20 MB. Dividí el archivo para registrar la selección.')
  return payload
}

export function parseInWorker(bytes: Buffer, options: ParseOptions): Promise<ParsedImport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import-worker.ts', import.meta.url), { workerData: { bytes, options }, resourceLimits: { maxOldGenerationSizeMb: 128 } })
    const timer = setTimeout(() => { void worker.terminate(); reject(new ApiError(422, 'El archivo tardó demasiado en analizarse. Dividilo y volvé a intentar.')) }, 15_000)
    worker.once('message', (message: { result?: ParsedImport; error?: string }) => {
      clearTimeout(timer); void worker.terminate()
      if (message.result) resolve(message.result)
      else reject(new ApiError(422, message.error ?? 'No se pudo analizar el archivo.'))
    })
    worker.once('error', () => { clearTimeout(timer); reject(new ApiError(422, 'No se pudo analizar el archivo dentro de los recursos disponibles.')) })
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new ApiError(422, 'Se interrumpió el análisis. Probá con un archivo más pequeño.')) })
  })
}
