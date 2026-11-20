import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createInboxIngestCycle} from '../src/inbox/ingest-cycle.ts'
import type {MachineCommand} from '../src/campaigns/machine-store.ts'
import type {ZernioClient} from '../src/inbox/provider.ts'
for(const withSync of [false,true])test(`history without checkpoint support preserves watermark; declared feed requires its checkpoint (${withSync})`,async()=>{
 const calls:{action:string;data:Record<string,unknown>}[]=[]
 const command:MachineCommand=async<T>(action:string,data:Record<string,unknown>)=>{
  calls.push({action,data})
  if(action==='context')return {workspaceId:'workspace',profileId:'profile'} as T
  if(action==='claim_sync')return {id:'job',lease:'lease',externalAccountId:'account',channel:'instagram',conversation_key:'',updated_since:'1970-01-01T00:00:00.000Z',cursor:null} as T
  return null as T
 }
 const provider={account:async()=>({_id:'account',profileId:'profile',platform:'instagram',isActive:true}),
  conversations:async()=>({data:[],pagination:{hasMore:false,nextCursor:null},...(withSync?{sync:{nextUpdatedSince:null}}:{}),meta:{accountsFailed:0}})} as unknown as ZernioClient
 await createInboxIngestCycle(command,provider,{workspaceId:'workspace',profileId:'profile'})()
 if(withSync){assert.ok(calls.some(c=>c.action==='fail_sync'&&c.data.code==='history_checkpoint_missing'));assert.ok(!calls.some(c=>c.action==='finish_sync'))}
 else{assert.equal(calls.find(c=>c.action==='finish_sync')?.data.updatedSince,'1970-01-01T00:00:00.000Z');assert.ok(!calls.some(c=>c.action==='fail_sync'))}
})
