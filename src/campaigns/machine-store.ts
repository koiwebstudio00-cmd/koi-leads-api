import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
export type MachineCommand = <T = unknown>(action: string, data: Record<string, unknown>) => Promise<T>

export function machineConnectionOptions(connection: string, caFile?: string) {
  let url: URL
  try { url = new URL(connection) } catch { throw new Error('Conexión PostgreSQL inválida') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Conexión PostgreSQL inválida')
  // No permitir que parámetros de conexión desactiven la verificación TLS.
  for (const key of ['sslmode','sslcert','sslkey','sslrootcert']) url.searchParams.delete(key)
  const localTest = process.env.NODE_ENV === 'test' && ['127.0.0.1','localhost'].includes(url.hostname)
  return { connectionString: url.toString(), max: 2, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000,
    ssl: localTest ? false : { rejectUnauthorized: true, ...(caFile ? { ca: readFileSync(caFile,'utf8') } : {}) },
    statement_timeout: 10000, query_timeout: 12000, application_name: 'koi-dispatch',
  }
}

export function createMachineStore(connection: string, caFile?: string) {
  const pool = new Pool(machineConnectionOptions(connection, caFile))
  pool.on('error', () => console.error(JSON.stringify({ event: 'database_connection_error' })))
  const command: MachineCommand = async <T>(action: string, data: Record<string, unknown>) => {
    const result = await pool.query<{ result: T }>('select koi_private.worker_command($1,$2::jsonb) as result', [action, JSON.stringify(data)])
    return result.rows[0]!.result
  }
  return { command, close: () => pool.end() }
}
