import Papa from 'papaparse'
import readExcelFile from 'read-excel-file/node'
import { Unzip, UnzipInflate, zipSync } from 'fflate'
import { Parser } from 'saxen'
import { createHash } from 'node:crypto'
import { IMPORT_LIMITS, type ParsedImport } from './contracts/imports.ts'

export type ParseOptions = { filename: string; sheet: number; headerRow: number; delimiter: string; encoding: 'utf-8' | 'windows-1252' }
const fail = (message: string): never => { throw new Error(message) }

// Inspección en streaming: no confiar en los tamaños declarados por un ZIP.
export function inspectXlsx(bytes: Uint8Array) {
  let total = 0; let entries = 0; let cells = 0; let formulas = false
  const names = new Set<string>()
  const files: Record<string, Uint8Array> = Object.create(null)
  let finished = 0
  const unzip = new Unzip(file => {
    if (++entries > 1000 || names.has(file.name) || /(^\/|(^|\/)\.\.(\/|$)|\\)/.test(file.name)) fail('Estructura XLSX no admitida.')
    names.add(file.name)
    if (/vbaProject|\.bin$|encryptedPackage/i.test(file.name)) fail('No se admiten macros ni archivos cifrados.')
    let size = 0
    const chunks: Uint8Array[] = []
    file.ondata = (error, data, final) => {
      if (error) throw error
      size += data.length; total += data.length
      if (size > 8 * 1024 * 1024 || total > 32 * 1024 * 1024) fail('El XLSX descomprimido supera el límite de 32 MiB o una hoja supera 8 MiB.')
      chunks.push(data)
      if (final) { files[file.name] = Buffer.concat(chunks); finished++ }
      if (final && /\.xml$/i.test(file.name)) {
        const xml = new TextDecoder('utf-8',{ fatal:true }).decode(files[file.name])
        if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('No se admiten declaraciones de entidades XML.')
        if (/^xl\/worksheets\//.test(file.name)) {
          const parser = new Parser()
          parser.on('error', () => fail('XML de hoja mal formado.'))
          parser.on('warn', () => fail('La hoja contiene atributos XML no válidos.'))
          let sheetRows = 0; let rowCells = 0
          parser.on('openTag', (name,getAttributes,decode) => {
            const tag = name.split(':').at(-1)
            const attrs = getAttributes()
            if (tag === 'f') formulas = true
            if (tag === 'row') {
              rowCells = 0; sheetRows++
              const row = attrs.r ? Number(decode(attrs.r)) : sheetRows
              if (!Number.isSafeInteger(row) || row < 1 || row > IMPORT_LIMITS.rows + 100 || sheetRows > IMPORT_LIMITS.rows + 100) fail('El libro supera 5.100 filas por hoja.')
            }
            if (tag === 'c') {
              if (++cells > IMPORT_LIMITS.cells || ++rowCells > IMPORT_LIMITS.columns) fail('El libro supera 100.000 celdas o 50 columnas.')
              const address = decode(attrs.r ?? '')
              const match = /^([A-Z]+)(\d+)$/.exec(address)
              if (!match) fail('Una celda XLSX no tiene una posición válida.')
              let column = 0
              for (const letter of match![1]!) column = column * 26 + letter.charCodeAt(0) - 64
              if (column > IMPORT_LIMITS.columns || Number(match![2]) > IMPORT_LIMITS.rows + 100) fail('El libro supera 50 columnas o 5.100 filas por hoja.')
            }
          })
          parser.parse(xml)
        }
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  for (let offset = 0; offset < bytes.length; offset += 4096) unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length)
  if (finished !== entries || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) fail('El archivo no es un libro XLSX válido.')
  return { formulas, files }
}

export async function parseImport(bytes: Uint8Array, options: ParseOptions): Promise<ParsedImport> {
  if (!bytes.length || bytes.length > IMPORT_LIMITS.bytes) fail('El archivo debe tener contenido y pesar como máximo 10 MiB.')
  let grids: { sheet: string; data: string[][] }[]
  let delimiter = options.delimiter
  const warnings: string[] = []
  if (/\.csv$/i.test(options.filename)) {
    if (bytes.includes(0)) fail('CSV no admitido: guardalo como UTF-8 o Windows-1252.')
    let source: string
    try { source = new TextDecoder(options.encoding, { fatal: true }).decode(bytes) }
    catch { return fail('No se pudo leer el texto. Probá la codificación Windows-1252 o exportá como UTF-8.') }
    const parsed = Papa.parse<string[]>(source.replace(/^\uFEFF/, ''), { delimiter, skipEmptyLines: false, dynamicTyping: false })
    const errors = parsed.errors.filter(error => error.code !== 'UndetectableDelimiter')
    if (errors.length) fail(`CSV mal formado: ${errors[0]!.code}. Revisá comillas y separadores.`)
    delimiter = parsed.meta.delimiter
    // Un salto al final cierra el último registro, no representa una fila adicional.
    if (/\r?\n$/.test(source) && parsed.data.at(-1)?.every(cell => cell === '')) parsed.data.pop()
    grids = [{ sheet: 'CSV', data: parsed.data }]
  } else if (/\.xlsx$/i.test(options.filename)) {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail('El contenido no corresponde a un XLSX.')
    const inspected = inspectXlsx(bytes)
    if (inspected.formulas) warnings.push('Hay fórmulas: se muestran sus últimos valores guardados; no se ejecutan ni recalculan.')
    // El parser recibe exclusivamente entradas inspeccionadas, sin depender de un
    // directorio central ZIP que podría contradecir sus encabezados locales.
    const sheets = await readExcelFile(Buffer.from(zipSync(inspected.files,{ level:0 })), { trim: false, parseNumber: value => value })
    if (sheets.length > 20) fail('Se admiten hasta 20 hojas por libro.')
    grids = sheets.map(sheet => ({ sheet: sheet.sheet, data: sheet.data.map(row => row.map(cell => cell instanceof Date ? cell.toISOString() : cell === null || cell === undefined ? '' : String(cell))) }))
    delimiter = ''
  } else return fail('Elegí un archivo .csv o .xlsx.')
  const grid = grids[options.sheet - 1]
  if (!grid) return fail('No encontramos la hoja seleccionada.')
  if (grid.data.length > IMPORT_LIMITS.rows + options.headerRow) fail('Se admiten hasta 5.000 filas de datos por importación. Dividí el archivo para continuar.')
  if (!grid.data[options.headerRow - 1]) fail('La fila de encabezados no existe.')
  const columns = Math.max(...grid.data.map(row => row.length), 0)
  if (!columns || columns > IMPORT_LIMITS.columns || grid.data.length * columns > IMPORT_LIMITS.cells) fail('Se admiten hasta 50 columnas y 100.000 celdas por hoja.')
  if (grid.data.some(row => row.some(cell => cell.length > IMPORT_LIMITS.cellLength))) fail('Una celda supera los 1.000 caracteres. Dividí o acortá ese contenido.')
  const headers = Array.from({ length: columns }, (_, index) => grid.data[options.headerRow - 1]![index] || `Columna ${index + 1}`)
  if (new Set(headers).size !== headers.length) warnings.push('Hay encabezados repetidos: cada columna conserva su posición y sus datos.')
  const rows = grid.data.slice(options.headerRow).map((cells, index) => ({ row: options.headerRow + index + 1, cells: Array.from({ length: columns }, (_, col) => cells[col] ?? '') }))
  if (!rows.length) fail('No hay filas de datos después del encabezado.')
  const result: ParsedImport = { filename: options.filename, hash: createHash('sha256').update(bytes).digest('hex'), sheet: grid.sheet, sheets: grids.map(grid => grid.sheet), headerRow: options.headerRow, headers, rows, emptyRows: rows.filter(row => row.cells.every(cell => !cell.trim())).length, warnings, delimiter, encoding: /\.csv$/i.test(options.filename) ? options.encoding : 'xlsx' }
  if (Buffer.byteLength(JSON.stringify(result)) > IMPORT_LIMITS.previewBytes) fail('La vista previa supera 8 MiB. Dividí el archivo en partes más pequeñas.')
  return result
}
