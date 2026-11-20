import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {IncomingMessage} from 'node:http'
import {chatRoute} from '../src/conversations.ts'
test('index route validates targeted refreshes and cursor before invoking SQL',async()=>{
 const id='11111111-1111-4111-8111-111111111111',calls:unknown[]=[]
 const run=(query:string)=>chatRoute({method:'GET'} as IncomingMessage,new URL('http://localhost/api/conversations/index'+query),async(action,data)=>{calls.push({action,data});return {}},async()=>({}))
 await run('');await run('?after='+id);await run('?ids='+id)
 assert.deepEqual(calls,[{action:'inbox_index',data:{}},{action:'inbox_index',data:{after:id}},{action:'inbox_index',data:{ids:[id]}}])
 for(const query of ['?ids=bad','?ids=','?ids='+Array(101).fill(id).join(','),'?after='+id+'&ids='+id,'?workspaceId='+id])await assert.rejects(run(query))
 assert.equal(calls.length,3)
})
