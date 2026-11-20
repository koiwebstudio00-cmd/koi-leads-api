import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { inboxManualSendInput, type InboxOutboundFile } from '../src/inbox/outbound-media.ts'
import { prepareVoiceForDispatch } from '../src/inbox/voice-conversion.ts'

const ffmpegAvailable = spawnSync('ffmpeg',['-version'],{timeout:3000,windowsHide:true}).status===0
function generate(container:'webm'|'mp4') {
 const codec=container==='webm'?['-c:a','libopus']:['-c:a','aac','-movflags','frag_keyframe+empty_moov']
 const result=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=500:sample_rate=48000:duration=0.3',
   '-ac','2',...codec,'-f',container,'pipe:1'],{timeout:6000,windowsHide:true})
 assert.equal(result.status,0)
 return result.stdout as Buffer
}
for(const container of ['webm','mp4'] as const) {
 test('converts a '+container+' microphone recording to a playable mono Ogg/Opus WhatsApp voice note',{
   skip: ffmpegAvailable?false:'ffmpeg is installed in the Inbox worker image'
 },async()=>{
   const original:InboxOutboundFile={name:'voz.'+container,mime:'audio/'+container as 'audio/webm'|'audio/mp4',base64:generate(container).toString('base64'),voiceNote:true}
   assert.ok(inboxManualSendInput.safeParse({attachment:original}).success)
   const outgoing=await prepareVoiceForDispatch(original)
   assert.equal(outgoing.mime,'audio/ogg')
   assert.notEqual(outgoing.base64,original.base64)
   assert.ok(inboxManualSendInput.safeParse({attachment:outgoing}).success)
   const decoded=spawnSync('ffmpeg',['-v','error','-f','ogg','-i','pipe:0','-f','s16le','pipe:1'],{
     input:Buffer.from(outgoing.base64,'base64'),timeout:6000,windowsHide:true})
   assert.equal(decoded.status,0)
   assert.ok(decoded.stdout.length>=20000 && decoded.stdout.some(x=>x!==0))
 })
}
test('only recordings marked as voice notes can enter the WebM conversion path',async()=>{
 const file={name:'a.webm',mime:'audio/webm' as const,base64:Buffer.from('1a45dfa300007765626d','hex').toString('base64')}
 assert.equal(inboxManualSendInput.safeParse({attachment:file}).success,false)
 const invalid={...file,base64:'AA==',voiceNote:true}
 assert.equal(inboxManualSendInput.safeParse({attachment:invalid}).success,false)
 assert.equal(await prepareVoiceForDispatch(file),file)
 const cancel=new AbortController();cancel.abort()
 await assert.rejects(prepareVoiceForDispatch({...file,voiceNote:true},cancel.signal))
})
