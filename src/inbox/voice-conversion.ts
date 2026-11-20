import { spawn } from 'node:child_process'
import type { InboxOutboundFile } from './outbound-media.ts'

const maxRecordingBytes = 4 * 1024 * 1024
const maxEncodedBytes = 2 * 1024 * 1024
const maxDurationSeconds = 183 // three-minute recording plus MediaRecorder's delayed stop event

// Check page boundaries, declared packet sizes, mono Opus identification and final sample time.
function convertedVoiceIsValid(bytes:Buffer): boolean {
  let page=0, pages=0, lastGranule=0n, preSkip=0, eos=false
  while(page < bytes.length) {
    if(page+27>bytes.length || bytes.toString('ascii',page,page+4)!=='OggS' || bytes[page+4]!==0 || eos)return false
    const segments=bytes[page+26]!
    const payload=page+27+segments
    if(payload>bytes.length)return false
    let size=0
    for(const n of bytes.subarray(page+27,payload))size+=n
    if(payload+size>bytes.length)return false
    if(pages===0) {
      if(size<19 || bytes.toString('ascii',payload,payload+8)!=='OpusHead' || bytes[payload+9]!==1)return false
      preSkip=bytes.readUInt16LE(payload+10)
    }
    const granule=bytes.readBigInt64LE(page+6)
    if(granule>=0n)lastGranule=granule
    eos=(bytes[page+5]! & 4)!==0
    page=payload+size
    pages++
  }
  const samples=lastGranule-BigInt(preSkip)
  return eos && pages>=3 && samples>0n && samples<=BigInt(maxDurationSeconds*48000)
}

function encode(input:Buffer, demuxer:'matroska'|'mov',signal?:AbortSignal):Promise<Buffer> {
  if(signal?.aborted)return Promise.reject(new Error('Recording cancelled'))
  return new Promise((resolve,reject)=>{
    // Force a single demuxer and allow only stdin/stdout. The media cannot refer to local files or URLs.
    const child=spawn('ffmpeg',[
      '-hide_banner','-nostdin','-loglevel','error','-max_alloc','16777216',
      '-protocol_whitelist','pipe','-probesize','1048576','-analyzeduration','1000000',
      '-threads','1','-codec_whitelist','aac,opus','-f',demuxer,'-i','pipe:0',
      '-map','0:a:0','-vn','-sn','-dn','-map_metadata','-1','-filter_threads','1',
      '-t', String(maxDurationSeconds+1),'-c:a','libopus','-application','voip',
      '-threads','1','-ac','1','-ar','48000','-b:a','48000','-f','ogg','pipe:1',
    ],{stdio:['pipe','pipe','ignore'],windowsHide:true})
    const chunks: Buffer[]=[]
    let size=0,cancelled=false
    function terminate(){cancelled=true;child.kill('SIGKILL')}
    const timeout=setTimeout(terminate,12000)
    signal?.addEventListener('abort',terminate,{once:true})
    const cleanup=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',terminate)}
    child.on('error',()=>{cleanup();reject(new Error('Voice encoder unavailable'))})
    child.stdout.on('data',(data:Buffer)=>{
      size+=data.length
      if(size>maxEncodedBytes){terminate();return}
      chunks.push(data)
    })
    // Decoder rejection can close stdin before all input has been written.
    child.stdin.on('error',()=>{})
    child.once('close',code=>{
      cleanup()
      if(cancelled || code!==0 || !size || size>maxEncodedBytes){reject(new Error('Voice conversion failed'));return}
      const result=Buffer.concat(chunks)
      if(!convertedVoiceIsValid(result)){reject(new Error('Invalid converted note'));return}
      resolve(result)
    })
    child.stdin.end(input)
  })
}

export async function prepareVoiceForDispatch(file:InboxOutboundFile,signal?:AbortSignal):Promise<InboxOutboundFile> {
  if(!file.voiceNote || file.mime==='audio/ogg')return file
  if(!['audio/webm','audio/mp4'].includes(file.mime))throw new Error('Unsupported recording')
  const source=Buffer.from(file.base64,'base64')
  if(!source.length || source.length>maxRecordingBytes)throw new Error('Recording too large')
  const converted=await encode(source,file.mime==='audio/webm'?'matroska':'mov',signal)
  return {...file,mime:'audio/ogg',name:'nota-de-voz.ogg',base64:converted.toString('base64')}
}
