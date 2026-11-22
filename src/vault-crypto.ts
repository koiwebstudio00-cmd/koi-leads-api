import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto'
import { ApiError } from './store.ts'

export type Binding={workspace:string;id:string;kind:string}
export type VaultKeys={active:number;keys:Map<number,Buffer>}
export function readVaultKeys(raw:string|undefined,active:string|undefined):VaultKeys|undefined {
  if(!raw&&!active)return undefined
  try{
    const keys=new Map<number,Buffer>()
    for(const [v,value] of Object.entries(JSON.parse(raw??''))){
      if(!/^[1-9]\d*$/.test(v)||typeof value!=='string')throw Error()
      const key=Buffer.from(value,'base64')
      if(key.length!==32||key.toString('base64')!==value)throw Error()
      keys.set(Number(v),key)
    }
    if(!keys.has(Number(active)))throw Error()
    return {active:Number(active),keys}
  }catch{throw Error('Configuración de llaves de bóveda inválida.')}
}
function aad(b:Binding,version:number){return Buffer.from(JSON.stringify(['koi-vault',version,b.workspace,b.id,b.kind]))}
export function seal(keys:VaultKeys,b:Binding,plaintext:string){
  const iv=randomBytes(12),version=keys.active,cipher=createCipheriv('aes-256-gcm',keys.keys.get(version)!,iv)
  cipher.setAAD(aad(b,version))
  const data=Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()])
  return {version,envelope:Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64')}
}
export function unseal(keys:VaultKeys,b:Binding,version:number,envelope:string){
  try{
    const data=Buffer.from(envelope,'base64')
    const cipher=createDecipheriv('aes-256-gcm',keys.keys.get(version)!,data.subarray(0,12))
    cipher.setAAD(aad(b,version));cipher.setAuthTag(data.subarray(12,28))
    return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8')
  }catch{throw new ApiError(503,'No pudimos recuperar el elemento con la llave configurada.')}
}
