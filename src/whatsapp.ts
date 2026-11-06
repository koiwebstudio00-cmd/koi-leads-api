import { z } from 'zod'
import { ApiError, type UserStore } from './store.ts'
import { createEvolutionConnection } from './evolution.ts'
import type { EvolutionStatus } from './contracts/evolution.ts'
export type WhatsAppInstance = { id:string; label:string; instanceName:string; campaignSender:boolean; status:EvolutionStatus }
export type WhatsAppManager = {
  workspaceId:string
  list(store:UserStore):Promise<{instances:WhatsAppInstance[];canManage:boolean}>
  create(store:UserStore,label:string,key:string):Promise<WhatsAppInstance>
  action(store:UserStore,id:string,action:'connect'|'restart'|'disconnect'):Promise<{qr:string|null;expiresAt:string|null}>
}
export function createWhatsAppManager(config:{url:string;apiKey:string;instanceName:string;workspaceId:string},dependencies:{fetch?:typeof fetch}={}):WhatsAppManager {
  const request=dependencies.fetch??fetch
  const busy=new Set<string>()
  async function exclusive<T>(name:string,run:()=>Promise<T>) {
    if(busy.has(name))throw new ApiError(409,'Ya hay una operación en curso para esta conexión.')
    busy.add(name);try{return await run()}finally{busy.delete(name)}
  }
  async function provider(path:string,method='GET',body?:unknown):Promise<Record<string,unknown>> {
    let response:Response
    try { response=await request(`${config.url}${path}`,{method,headers:{apikey:config.apiKey,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000),redirect:'error'}) }
    catch {throw new ApiError(503,'No pudimos confirmar la operación. Actualizá el estado antes de volver a intentar.')}
    if(!response.ok){await response.body?.cancel();throw new ApiError(502,'WhatsApp no pudo completar la operación. Actualizá el estado y volvé a intentar.')}
    const data=await response.json().catch(()=>null)
    if(!data || typeof data!=='object' || data.error===true)throw new ApiError(502,'El servicio no pudo confirmar la operación.')
    return data
  }
  function guard(store:UserStore,admin=false){
    if(store.membership.workspace_id!==config.workspaceId)throw new ApiError(403,'Esta conexión no pertenece a tu espacio.')
    if(admin&&store.membership.role!=='admin')throw new ApiError(403,'Solo un administrador puede gestionar conexiones.')
    if(!store.whatsapp)throw new ApiError(503,'Gestión de conexiones no disponible.')
    return store.whatsapp
  }
  async function describe(id:string,label:string,name:string):Promise<WhatsAppInstance>{
    return {id,label,instanceName:name,campaignSender:id==='primary',status:await createEvolutionConnection({...config,instanceName:name},{fetch:request}).status()}
  }
  async function ensure(name:string){
    const state=await createEvolutionConnection({...config,instanceName:name},{fetch:request}).status()
    if(state.issue==='instance_missing')await provider('/instance/create','POST',{instanceName:name,integration:'WHATSAPP-BAILEYS',qrcode:false,groupsIgnore:true,syncFullHistory:false})
    else if(state.state==='unavailable')throw new ApiError(503,'No pudimos verificar si la instancia existe. Actualizá el estado antes de continuar.')
  }
  return {
    workspaceId:config.workspaceId,
    async list(store){
      const registry=guard(store);const rows=await registry.list()
      const instances=[await describe('primary','Número de campañas',config.instanceName)]
      // Bounded batches avoid flooding Evolution as more sessions are registered.
      for(let i=0;i<rows.length;i+=3)instances.push(...await Promise.all(rows.slice(i,i+3).map(r=>describe(r.id,r.label,r.instance_name))))
      return {instances,canManage:store.membership.role==='admin'}
    },
    async create(store,label,key){
      const registry=guard(store,true);const record=await registry.reserve(label,key)
      return exclusive(record.instance_name,async()=>{await ensure(record.instance_name);return describe(record.id,record.label,record.instance_name)})
    },
    async action(store,id,action){
      const registry=guard(store,true)
      const name=id==='primary'?config.instanceName:(await registry.get(z.uuid().parse(id))).instance_name
      return exclusive(name,async()=>{
        if(id==='primary'&&action!=='connect')await registry.assertIdle()
        if(action==='connect'){
          if(id!=='primary')await ensure(name)
          const data=await provider(`/instance/connect/${encodeURIComponent(name)}`)
          const nested=z.object({base64:z.string().optional()}).safeParse(data.qrcode)
          const raw=typeof data.base64==='string'?data.base64:nested.success?nested.data.base64:undefined
          // Only an inline PNG may be returned; never provider tokens, raw code, SVG or remote URLs.
          const qr=raw&&raw.length<300000&&/^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(raw)?raw:null
          return {qr,expiresAt:qr?new Date(Date.now()+40000).toISOString():null}
        }
        await provider(`/instance/${action==='restart'?'restart':'logout'}/${encodeURIComponent(name)}`,action==='restart'?'POST':'DELETE')
        return {qr:null,expiresAt:null}
      })
    },
  }
}
