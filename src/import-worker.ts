import { parentPort, workerData } from 'node:worker_threads'
import { parseImport, type ParseOptions } from './import-parser.ts'

const data = workerData as { bytes: Uint8Array; options: ParseOptions }
try { parentPort?.postMessage({ result: await parseImport(data.bytes, data.options) }) }
catch (error) { parentPort?.postMessage({ error: error instanceof Error ? error.message : 'No se pudo analizar el archivo.' }) }
