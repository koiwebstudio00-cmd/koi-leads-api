import type { PGlite } from '@electric-sql/pglite'
export const inboxFixture={
 wa:'a1000000-0000-4000-8000-000000000001',ig:'a1000000-0000-4000-8000-000000000002',
 waChat:'b1000000-0000-4000-8000-000000000001',igChat:'b1000000-0000-4000-8000-000000000002',
 lead:'c1000000-0000-4000-8000-000000000001',
}
export async function seedInbox(db:PGlite,workspace:string,user:string){
 const f=inboxFixture
 await db.query("insert into koi_leads(id,workspace_id,name,phone,company,created_by) values($1,$2,'Ana Inbox',null,'Estudio de prueba',$3)",[f.lead,workspace,user])
 for(const [account,chat,channel,external,label,address] of [[f.wa,f.waChat,'whatsapp','fixture-wa','Koi Ads','+5493810000000'],[f.ig,f.igChat,'instagram','fixture-ig','Koi Instagram','@koi.test']]){
  await db.query("insert into koi_inbox_accounts(id,workspace_id,channel,external_id,label,address,state,created_by) values($1,$2,$3,$4,$5,$6,'connected',$7)",[account,workspace,channel,external,label,address,user])
  const identity=(await db.query<{id:string}>("insert into koi_private.inbox_identities(workspace_id,account_id,channel,lead_id,external_id,display_name,username) values($1,$2,$3,$4,'ana','Ana Inbox','@ana.test') returning id",[workspace,account,channel,f.lead])).rows[0]!.id
  await db.query("insert into koi_inbox_conversations(id,workspace_id,account_id,channel,external_id,identity_id,lead_id,last_inbound_at,last_live_inbound_at) values($1,$2,$3,$4,$5,$6,$7,now()-interval '1 minute',now()-interval '1 minute')",[chat,workspace,account,channel,'thread-'+external,identity,f.lead])
  await db.query("insert into koi_private.inbox_messages(workspace_id,account_id,conversation_id,external_id,direction,body,sent_at,historical,status) select $1,$2,$3,'old-'||n,'in','Historial '||n,now()-interval '2 days',true,'received' from generate_series(1,60) n",[workspace,account,chat])
  await db.query("insert into koi_private.inbox_messages(workspace_id,account_id,conversation_id,external_id,direction,body,sent_at,status,provider_attachments) values($1,$2,$3,'live','in',$4,now()-interval '1 minute','received',$5)",[workspace,account,chat,channel==='whatsapp'?'Consulta desde WhatsApp':'Consulta desde Instagram',JSON.stringify([{type:'image',mimeType:'image/png',filename:'referencia.png'},{type:'document',mimeType:'application/pdf',filename:'propuesta.pdf'}])])
 }
}
