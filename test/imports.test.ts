import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { parseImport, inspectXlsx } from '../src/import-parser.ts'
import { prepareCommit } from '../src/import-service.ts'
import { normalizePhone, prepareRows, suggestMapping, safeCsvCell, type ImportDraft, type ImportChoices, type ImportResult } from '../src/contracts/imports.ts'
import { zipSync, strToU8 } from 'fflate'
import { fixtureWorkbook } from './fixture-workbook.ts'

const options = { filename: 'test.csv', sheet: 1, headerRow: 1, delimiter: '', encoding: 'utf-8' as const }
const csv = 'Nombre;Teléfono;Email;Empresa\r\n  Ana  ;+54 9 381 1111111;ana@example.test;Koi\r\nOtro nombre;+54 9 381 1111111;;\r\nSin teléfono;;;\r\nBeto;+54 9 381 2222222;;\r\n;;;\r\n'
let draft: ImportDraft
const user = '11111111-1111-4111-8111-111111111111'
const outsider = '22222222-2222-4222-8222-222222222222'
const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const db = new PGlite()
let result: ImportResult
let payload: ReturnType<typeof prepareCommit>
const key = randomUUID()
const choices = (): ImportChoices => ({ mapping: suggestMapping(draft.headers), country: 'AR', trim: true, edits: {}, selected: [2,3,5], consents: {}, target: { name: 'Base inicial', description: '' } })
async function run<T>(actor: string, fn: () => Promise<T>) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${actor}',false)`)
  try { return await fn() } finally { await db.exec('reset role; reset request.jwt.claim.sub') }
}
async function commit(id: string, requestKey: string, body: unknown) {
  return (await db.query<{ result: ImportResult }>('select public.koi_commit_import($1,$2,$3::jsonb) as result', [id,requestKey,JSON.stringify(body)])).rows[0]!.result
}
before(async () => {
  await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth, public to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
    insert into auth.users values ('${user}'),('${outsider}');`)
  const dir = new URL('../supabase/migrations/', import.meta.url)
  for (const file of (await readdir(dir)).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, dir), 'utf8'))
  await db.exec(`insert into public.koi_workspaces(id,name) values('${workspace}','Koi prueba'); insert into public.koi_workspace_members values('${workspace}','${user}','admin',now())`)
  const parsed = await parseImport(Buffer.from(csv),options)
  draft = { ...parsed, id: randomUUID(), status: 'draft', result: null }
  const staged = await run(user, () => db.query<{ id: string }>('insert into public.koi_imports(workspace_id,created_by,payload) values($1,$2,$3) returning id', [workspace,user,JSON.stringify(parsed)]))
  draft.id = staged.rows[0]!.id
})
after(() => db.close())

test('CSV preserves originals, empty rows, duplicate columns and source positions', async () => {
  assert.equal(draft.rows.length,5); assert.equal(draft.emptyRows,1); assert.equal(draft.rows[0]?.row,2)
  assert.equal(draft.rows[0]?.cells[0],'  Ana  '); assert.equal(draft.delimiter,';')
  const repeated = await parseImport(Buffer.from('nombre,nombre,telefono\nA,B,+14155550123'),options)
  assert.equal(repeated.headers.length,3); assert.equal(repeated.warnings.length,1)
  await assert.rejects(parseImport(Buffer.from('a,b\n"unfinished'),options),/CSV mal formado/)
  await assert.rejects(parseImport(Buffer.from('a\n' + 'x\n'.repeat(5001)),options),/5.000/)
})
test('normalization, edits and selection reject ambiguous data; CSV export neutralizes formulas', () => {
  assert.equal(normalizePhone('3811111111','AR').phone,'5493811111111')
  assert.equal(normalizePhone('+1 (415) 555-0123','international').phone,'14155550123')
  for (const value of ['5.49381e+12','381 15 1111111','549+3811111111','hello3811111111']) assert.ok(normalizePhone(value,'AR').error)
  const prepared = prepareRows(draft,choices())
  assert.equal(prepared[0]?.name,'Ana'); assert.equal(prepared[1]?.duplicate,true); assert.ok(prepared[2]?.error)
  assert.throws(() => prepareCommit(draft,{ ...choices(),selected:[4] }),/Fila 4/)
  assert.throws(() => prepareCommit(draft,{ ...choices(),selected:[9999] }),/selección/)
  assert.throws(() => prepareCommit(draft,{ ...choices(), mapping: { ...choices().mapping,name:1 } }),/repitas/)
  assert.throws(() => prepareCommit(draft,{ ...choices(),consents:{ 2:{ state:'granted',evidence:'' } } }),/evidencia/)
  assert.equal(safeCsvCell(' =HYPERLINK("evil")'),'"\' =HYPERLINK(""evil"")"')
})
test('XLSX supports multiple sheets, header offsets, saved formula values and blank source rows', async () => {
  const bytes = fixtureWorkbook()
  const first = await parseImport(bytes,{ ...options,filename:'test.xlsx' })
  assert.deepEqual(first.sheets,['Resumen','Contactos']); assert.equal(first.rows[0]?.cells[0],'2'); assert.equal(first.warnings.length,1)
  const second = await parseImport(bytes,{ ...options,filename:'test.xlsx',sheet:2,headerRow:2 })
  assert.deepEqual(second.headers,['Nombre','Teléfono','Empresa']); assert.equal(second.rows.length,3); assert.equal(second.emptyRows,1)
  assert.equal(second.rows[0]?.row,3); assert.equal(second.rows[2]?.cells[1],'5493814444444')
})
test('ZIP inspection rejects disguised files, macros, entity declarations and excessive inflation', () => {
  assert.throws(() => inspectXlsx(zipSync({ 'fake.txt':strToU8('x') })),/XLSX válido/)
  assert.throws(() => inspectXlsx(zipSync({ 'xl/vbaProject.bin':new Uint8Array(1) })),/macros/)
  assert.throws(() => inspectXlsx(zipSync({ 'xl/workbook.xml':strToU8('<!DOCTYPE test>') })),/entidades/)
  assert.throws(() => inspectXlsx(zipSync({ 'bomb.xml':new Uint8Array(9*1024*1024) })),/límite/)
  assert.throws(() => inspectXlsx(zipSync({ 'xl/worksheets/sheet1.xml':strToU8("<worksheet><row r='999999999'/></worksheet>") })),/5.100/)
  assert.throws(() => inspectXlsx(zipSync({ 'xl/worksheets/sheet1.xml':strToU8("<worksheet><row r='1'><c r='ZZ1'/></row></worksheet>") })),/50 columnas/)
})
test('staging creates no leads; transactional commit reconciles selection and records originals', async () => {
  assert.equal((await db.query('select * from public.koi_leads')).rows.length,0)
  payload = prepareCommit(draft,choices())
  result = await run(user, () => commit(draft.id,key,payload))
  assert.deepEqual({ ...result,importId:'id',listId:'list' },{ importId:'id',listId:'list',total:5,selected:3,created:2,linked:0,alreadyLinked:0,duplicates:1,excluded:2,blocked:0 })
  assert.equal((await db.query('select * from public.koi_leads')).rows.length,2)
  const rows = await db.query<{ original:{ cells:string[] } }>('select original from public.koi_import_rows order by source_row')
  assert.equal(rows.rows.length,5); assert.equal(rows.rows[0]!.original.cells[0],'  Ana  ')
  assert.equal((await db.query("select * from public.koi_audit_events where action = 'import.committed'")).rows.length,1)
})
test('identical retries return same report; conflicting retry cannot change committed data', async () => {
  assert.deepEqual(await run(user, () => commit(draft.id,key,payload)),result)
  await assert.rejects(run(user, () => commit(draft.id,randomUUID(),payload)),/already committed/)
  await assert.rejects(run(user, () => commit(draft.id,key,{ ...payload,target:{ name:'Other',description:'' } })),/already committed/)
})
test('preflight counts existing and new phones without REST truncation',async () => {
  const checked = await run(user,() => db.query<{ answer:{ newContacts:number;existingContacts:number;blocked:number } }>('select koi_check_import_phones($1) as answer',[['5493811111111','5493817777777','5493811111111']]))
  assert.deepEqual(checked.rows[0]!.answer,{ newContacts:1,existingContacts:1,blocked:0 })
})
test('reimport links existing contacts without overwrite and never removes suppressions', async () => {
  await db.query('insert into public.koi_suppressions(workspace_id,phone,reason) values($1,$2,$3)',[workspace,'5493811111111','Baja previa'])
  const next = { ...draft,id:randomUUID(),status:'draft' as const,result:null }
  await db.query('insert into public.koi_imports(id,workspace_id,created_by,payload) values($1,$2,$3,$4)',[next.id,workspace,user,JSON.stringify(draft)])
  const body = prepareCommit(next,{ ...choices(),target:{ name:'Segunda base',description:'' },edits:{ 2:['Nombre nuevo','+54 9 381 1111111','nuevo@example.test',''] },consents:{ 2:{ state:'granted',evidence:'Declaración de prueba' } } })
  const linked = await run(user, () => commit(next.id,randomUUID(),body))
  assert.equal(linked.created,0); assert.equal(linked.linked,2); assert.equal(linked.blocked,1)
  const contact = (await db.query<{ name:string;consent:string }>('select name,consent from public.koi_leads where phone=$1',['5493811111111'])).rows[0]!
  assert.equal(contact.name,'Ana'); assert.equal(contact.consent,'unknown')
})
test('invalid final row rolls back list, contacts and audit; duplicate denial takes precedence', async () => {
  const next = { ...draft,id:randomUUID() }
  await db.query('insert into public.koi_imports(id,workspace_id,created_by,payload) values($1,$2,$3,$4)',[next.id,workspace,user,JSON.stringify(draft)])
  const body = prepareCommit(next,{ ...choices(),target:{ name:'Rollback',description:'' } })
  body.rows[3]!.phone = 'bad'
  await assert.rejects(run(user, () => commit(next.id,randomUUID(),body)),/Invalid selected/)
  assert.equal((await db.query("select * from public.koi_lead_lists where name='Rollback'")).rows.length,0)
  assert.equal((await db.query('select * from public.koi_import_rows where import_id=$1',[next.id])).rows.length,0)
  const valid = prepareCommit(next,{ ...choices(),target:{ listId:result.listId },consents:{ 5:{ state:'denied',evidence:'Pedido de baja de prueba' } } })
  const report = await run(user, () => commit(next.id,randomUUID(),valid))
  assert.equal(report.alreadyLinked,2); assert.equal(report.blocked,2)
})
test('anonymous, non-member and direct mutations cannot bypass commit or forge results', async () => {
  await db.exec('set role anon')
  try { await assert.rejects(db.query('select public.koi_commit_import($1,$2,$3)',[draft.id,key,JSON.stringify(payload)]),/permission denied/) }
  finally { await db.exec('reset role') }
  await run(outsider, async () => {
    assert.equal((await db.query('select * from public.koi_leads')).rows.length,0)
    assert.equal((await db.query('select * from public.koi_import_rows')).rows.length,0)
    await assert.rejects(commit(draft.id,key,payload),/Membership required/)
  })
  await run(user, async () => {
    await assert.rejects(db.query("update public.koi_imports set status='committed'"),/permission denied/)
    await assert.rejects(db.query("update public.koi_leads set consent='granted'"),/permission denied/)
    await assert.rejects(db.query('delete from public.koi_suppressions'),/permission denied/)
    await assert.rejects(db.query('insert into public.koi_import_rows default values'),/permission denied/)
  })
})
test('saved preparations preserve edits and reject stale tab saves/commits',async () => {
  const next = { ...draft,id:randomUUID() }
  await db.query('insert into public.koi_imports(id,workspace_id,created_by,payload) values($1,$2,$3,$4)',[next.id,workspace,user,JSON.stringify(draft)])
  const edited = { ...choices(),selected:[],edits:{ 2:['Cambio guardado','+5493811111111','',''] } }
  const saved = await run(user,() => db.query<{ revision:number }>('select koi_save_import_draft($1,0,$2::jsonb) as revision',[next.id,JSON.stringify(edited)]))
  assert.equal(saved.rows[0]!.revision,1)
  await assert.rejects(run(user,() => db.query('select koi_save_import_draft($1,0,$2::jsonb)',[next.id,JSON.stringify(edited)])),/Stale draft/)
  await assert.rejects(run(user,() => commit(next.id,randomUUID(),prepareCommit(next,choices()))),/Stale draft/)
  const stored = (await db.query<{ choices:ImportChoices }>('select choices from koi_imports where id=$1',[next.id])).rows[0]!
  assert.deepEqual(stored.choices.edits,edited.edits)
  const valid = prepareCommit(next,{ ...edited,revision:1,selected:[2],target:{ listId:result.listId } })
  assert.equal((await run(user,() => commit(next.id,randomUUID(),valid))).alreadyLinked,1)
})
test('another workspace cannot see, commit, save or target Koi imports and lists',async () => {
  const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  await db.query('insert into koi_workspaces(id,name) values($1,$2)',[second,'Otro equipo'])
  await db.query('insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,$3)',[second,outsider,'admin'])
  const otherDraft = { ...draft,id:randomUUID(),rows:[draft.rows[0]!] }
  await db.query('insert into koi_imports(id,workspace_id,created_by,payload) values($1,$2,$3,$4)',[otherDraft.id,second,outsider,JSON.stringify(otherDraft)])
  await run(outsider,async () => {
    assert.equal((await db.query('select * from koi_leads')).rows.length,0)
    assert.equal((await db.query('select * from koi_imports where id=$1',[draft.id])).rows.length,0)
    await assert.rejects(commit(draft.id,key,payload),/Import not found/)
    await assert.rejects(db.query('select koi_save_import_draft($1,0,$2::jsonb)',[draft.id,JSON.stringify(choices())]),/Import not found/)
    await assert.rejects(commit(otherDraft.id,randomUUID(),prepareCommit(otherDraft,{ ...choices(),selected:[2],target:{ listId:result.listId } })),/List outside workspace/)
    const report = await commit(otherDraft.id,randomUUID(),prepareCommit(otherDraft,{ ...choices(),selected:[2],target:{ name:'Base aislada',description:'' } }))
    assert.equal(report.created,1); assert.equal(report.blocked,0)
  })
})
test('a teammate cannot confirm or change another member’s preparation',async () => {
  const teammate = '33333333-3333-4333-8333-333333333333'
  await db.query('insert into auth.users values($1)',[teammate])
  await db.query('insert into koi_workspace_members(workspace_id,user_id,role) values($1,$2,$3)',[workspace,teammate,'operator'])
  await run(teammate,async () => {
    await assert.rejects(commit(draft.id,key,payload),/Import not found/)
    await assert.rejects(db.query('select koi_save_import_draft($1,0,$2::jsonb)',[draft.id,JSON.stringify(choices())]),/Import not found/)
  })
})
test('5,000-row import completes with reconciled totals at the supported limit',async context => {
  const large:ImportDraft = { ...draft,id:randomUUID(),headers:['Nombre','Teléfono'],rows:Array.from({ length:5000 },(_,index) => ({ row:index+2,cells:[`Contacto ${index+1}`,`+549381${8000000+index}`] })),emptyRows:0 }
  await db.query('insert into public.koi_imports(id,workspace_id,created_by,payload) values($1,$2,$3,$4)',[large.id,workspace,user,JSON.stringify(large)])
  const body = prepareCommit(large,{ ...choices(),mapping:suggestMapping(large.headers),selected:large.rows.map(row => row.row),target:{ name:'Prueba de 5000 filas',description:'' } })
  const started = performance.now()
  const report = await run(user,() => commit(large.id,randomUUID(),body))
  assert.equal(report.created,5000); assert.equal(report.selected,5000); assert.equal(report.excluded,0)
  context.diagnostic(`Commit SQL local de 5000 filas: ${Math.round(performance.now()-started)} ms`)
})
