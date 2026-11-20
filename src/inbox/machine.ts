import { Pool } from 'pg'
import { machineConnectionOptions,type MachineCommand } from '../campaigns/machine-store.ts'
export function createInboxMachine(connection:string,caFile?:string){
  const pool=new Pool({...machineConnectionOptions(connection,caFile),max:3,application_name:'koi-inbox',statement_timeout:3000,query_timeout:4000,connectionTimeoutMillis:3000})
  pool.on('error',()=>console.error(JSON.stringify({event:'inbox_database_unavailable'})))
  const command:MachineCommand=async<T>(action:string,data:Record<string,unknown>)=>{
    const result=await pool.query<{result:T}>('select koi_private.inbox_command($1,$2::jsonb) result',[action,JSON.stringify(data)])
    return result.rows[0]!.result
  }
  const dispatch:MachineCommand=async<T>(action:string,data:Record<string,unknown>)=>{
    const result=await pool.query<{result:T}>('select koi_private.inbox_dispatch($1,$2::jsonb) result',[action,JSON.stringify(data)])
    return result.rows[0]!.result
  }
  const reactions:MachineCommand=async<T>(action:string,data:Record<string,unknown>)=>{
    const result=await pool.query<{result:T}>('select koi_private.inbox_reaction_dispatch($1,$2::jsonb) result',[action,JSON.stringify(data)])
    return result.rows[0]!.result
  }
  const receive:MachineCommand=async<T>(action:string,data:Record<string,unknown>)=>{
    const result=await pool.query<{result:T}>('select koi_private.inbox_receive_job($1,$2::jsonb) result',[action,JSON.stringify(data)])
    return result.rows[0]!.result
  }
  return {command,dispatch,reactions,receive,close:()=>pool.end()}
}
