export const IMPORT_LIMITS = { bytes: 10 * 1024 * 1024, rows: 5000, columns: 50, cells: 100_000, cellLength: 1000, previewBytes: 8 * 1024 * 1024 } as const
export const FIELD_LABELS = { phone: 'Teléfono', name: 'Nombre', company: 'Empresa', email: 'Email', source: 'Origen' } as const
export type Field = keyof typeof FIELD_LABELS
export type Mapping = Record<Field, number | null>
export type Consent = { state: 'unknown' | 'granted' | 'denied'; evidence: string }
export type SourceRow = { row: number; cells: string[] }
export type ParsedImport = {
  filename: string; hash: string; sheet: string; sheets: string[]; headerRow: number
  headers: string[]; rows: SourceRow[]; emptyRows: number; warnings: string[]; delimiter: string; encoding: string
}
export type ImportDraft = ParsedImport & { id: string; status: 'draft' | 'committed'; result: ImportResult | null; choices?: ImportChoices | null; revision?: number }
export type ImportChoices = {
  revision?: number
  product?: string; updateFields?: ('name'|'company'|'email'|'source')[]; expectedRevisions?: Record<string,number>
  mapping: Mapping; country: 'AR' | 'international'; trim: boolean
  edits: Record<string, string[]>; selected: number[]; consents: Record<string, Consent>
  target: { listId: string } | { name: string; description: string }
}
export type PreparedRow = SourceRow & {
  phone: string; name: string; company: string; email: string; source: string
  extra: Record<string, string>; consent: Consent; error: string; warning: string; duplicate: boolean; blank: boolean
}
export type ImportResult = {
  updated?: number; importId: string; listId: string; total: number; selected: number; created: number
  linked: number; alreadyLinked: number; duplicates: number; excluded: number; blocked: number
}
export type ImportUpdate = {phone:string;revision:number;before:Record<string,unknown>;after:Record<string,unknown>}
export type ImportCheck = { updates?:ImportUpdate[]; newContacts: number; existingContacts: number; blocked: number }
export type RecentImport = { id:string; filename:string; status:'draft'|'committed'; created_at:string }
export type Lead = { revision: number; id: string; phone: string; name: string; company: string; email: string; source: string; consent: 'unknown' | 'granted' | 'denied'; suppressed: boolean }

export function suggestMapping(headers: string[]): Mapping {
  const mapping: Mapping = { phone: null, name: null, company: null, email: null, source: null }
  const aliases: Record<Field, string[]> = {
    phone: ['telefono', 'celular', 'whatsapp', 'phone', 'movil', 'numero'], name: ['nombre', 'nombre completo', 'name', 'contacto'],
    company: ['empresa', 'company', 'organizacion'], email: ['email', 'correo', 'e-mail'], source: ['origen', 'fuente', 'source'],
  }
  for (const field of Object.keys(aliases) as Field[]) mapping[field] = headers.findIndex(header => aliases[field].includes(header.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()))
  for (const field of Object.keys(mapping) as Field[]) if (mapping[field] === -1) mapping[field] = null
  return mapping
}

// Only explicit WhatsApp number links are parsed. Short links require resolution.
export function whatsappLinkPhone(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null
    let phone: string | null = null
    if (url.hostname === 'wa.me') phone = /^\/(?:c\/)?([1-9]\d{9,14})\/?$/.exec(url.pathname)?.[1] ?? null
    if (['api.whatsapp.com', 'web.whatsapp.com'].includes(url.hostname) && url.pathname === '/send') phone = url.searchParams.get('phone')?.replace(/^\+/, '') ?? null
    return phone && /^[1-9]\d{9,14}$/.test(phone) ? phone : null
  } catch { return null }
}

export function normalizePhone(value: string, country: ImportChoices['country']): { phone: string; error: string; warning: string } {
  // Algunos exportadores agregan un apóstrofo para que Excel trate el número como texto.
  let original = value.trim().replace(/^'(?=\+?\d)/, '')
  if (/^https?:\/\//i.test(original)) {
    const candidate = whatsappLinkPhone(original)
    if (!candidate) return { phone: '', error: 'El enlace de WhatsApp no contiene un número completo.', warning: '' }
    original = `+${candidate}`
  }
  const invalid = (error: string) => ({ phone: '', error, warning: '' })
  if (!original) return invalid('Falta el teléfono.')
  if (/[^\d+().\s-]/.test(original) || !/^(?:\+|00)?[\d().\s-]+$/.test(original)) return invalid('Usá un teléfono en texto, sin letras, extensiones ni notación científica.')
  let phone = original.replace(/[().\s-]/g, '')
  let warning = ''
  if (phone.startsWith('+')) phone = phone.slice(1)
  else if (phone.startsWith('00')) phone = phone.slice(2)
  else if (/^54(?:9\d{10}|\d{10})$/.test(phone)) { /* Prefijo argentino explícito. */ }
  else if (country === 'AR') {
    phone = phone.replace(/^0/, '')
    if (phone.length !== 10) return invalid('Número ambiguo: corregí a +código de país y número completo.')
    phone = `549${phone}`; warning = 'Se agregó 54 9 según la opción Argentina (celulares).'
  } else return invalid('Agregá + o 00 y el código de país.')
  if (!/^[1-9]\d{9,14}$/.test(phone)) return invalid('Se esperan entre 10 y 15 dígitos, sin cero inicial.')
  if (phone.startsWith('54') && !/^54(?:9\d{10}|\d{10})$/.test(phone)) return invalid('Revisá la longitud del teléfono argentino.')
  if (/^54\d{10}$/.test(phone)) warning = 'Número argentino sin 9: verificá si corresponde a un celular.'
  return { phone, error: '', warning }
}

export function prepareRows(draft: ParsedImport, choices: Pick<ImportChoices, 'mapping' | 'country' | 'trim' | 'edits' | 'consents'>): PreparedRow[] {
  const seen = new Set<string>()
  const used = new Set(Object.values(choices.mapping).filter(index => index !== null))
  return draft.rows.map(original => {
    const edited = choices.edits[String(original.row)] ?? original.cells
    const cells = edited.map(cell => choices.trim ? cell.trim().replace(/\s+/g, ' ') : cell)
    const value = (field: Field) => { const index = choices.mapping[field]; return index === null ? '' : (cells[index] ?? '') }
    const blank = cells.every(cell => !cell.trim())
    const phone = normalizePhone(value('phone'), choices.country)
    const consent = choices.consents[String(original.row)] ?? { state: 'unknown', evidence: '' }
    let error = blank ? 'Fila vacía.' : phone.error
    if (!error && value('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value('email').trim())) error = 'Revisá el email o dejalo vacío.'
    if (!error && consent.state !== 'unknown' && !consent.evidence.trim()) error = 'Falta la evidencia del consentimiento o rechazo.'
    if (!error && ['name', 'company', 'email', 'source'].some(field => value(field as Field).length > 250)) error = 'Un campo de contacto supera los 250 caracteres.'
    const duplicate = !!phone.phone && seen.has(phone.phone)
    if (phone.phone) seen.add(phone.phone)
    // La posición hace únicas las claves aunque el archivo repita encabezados.
    const extra = Object.fromEntries(draft.headers.flatMap((header, index) => used.has(index) ? [] : [[`${index + 1}:${header}`, cells[index] ?? '']]))
    const whatsappIndex = draft.headers.findIndex(header => header.trim().toLowerCase() === 'whatsapp')
    const candidate = whatsappIndex < 0 ? null : whatsappLinkPhone(cells[whatsappIndex] ?? '')
    if (candidate && (candidate === phone.phone || (/^549?\d{10}$/.test(candidate) && /^549?\d{10}$/.test(phone.phone) && candidate.slice(-10) === phone.phone.slice(-10)))) {
      extra.whatsapp_candidate = candidate
    }
    return { row: original.row, cells, phone: phone.phone, name: value('name'), company: value('company'), email: value('email'), source: value('source'), extra, consent, error, warning: phone.warning, duplicate, blank }
  })
}

export function safeCsvCell(value: string): string {
  const safe = /^[\s\u0000-\u001f]*[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/g, '""')}"`
}
