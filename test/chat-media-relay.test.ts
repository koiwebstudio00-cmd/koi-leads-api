import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatRoute, createChatMediaRelay } from '../src/conversations.ts'
import { ApiError } from '../src/store.ts'

const id = randomUUID()
const messageId = randomUUID()
const url = new URL('/api/conversations/' + id + '/attachment?messageId=' + messageId, 'http://localhost')
const request = { method: 'GET' } as IncomingMessage
const noBody = async () => undefined
const remoteFile = { name: 'Audio.ogg', mime: 'audio/ogg' as const, base64: Buffer.from('OggS fixture').toString('base64') }
const stored = { filename: 'Audio.ogg', mime: 'audio/ogg', base64: null, instance: 'test', providerId: 'remote-audio' }

test('recovers incoming media through the Koi API after authorizing the attachment locally', async () => {
  let authorized = false
  const relay = createChatMediaRelay(async (target, options) => {
    assert.ok(authorized)
    assert.equal(String(target), 'https://api-leads.koistudio.com.ar' + url.pathname + url.search)
    assert.equal(options?.headers && new Headers(options.headers).get('Authorization'), 'Bearer user-test-token')
    assert.equal(options?.redirect, 'error')
    assert.equal(options?.method, undefined)
    return Response.json(remoteFile)
  })
  const result = await chatRoute(request, url, async (action, data) => {
    assert.equal(action, 'attachment')
    assert.deepEqual(data, { id, messageId })
    authorized = true
    return stored
  }, noBody, undefined, undefined, lookup => relay('user-test-token', lookup))
  assert.deepEqual(result, { status: 200, data: remoteFile })
})

test('refuses unauthorized lookups and keeps attachments stored locally off the relay', async () => {
  const relay = async () => { throw new Error('unexpected relay call') }
  await assert.rejects(chatRoute(request, url, async () => { throw new ApiError(403, 'Sin permiso') },
    noBody, undefined, undefined, relay), { status: 403 })
  const result = await chatRoute(request, url, async () => ({ ...stored, base64: remoteFile.base64 }),
    noBody, undefined, undefined, relay)
  assert.deepEqual(result.data, remoteFile)
  await assert.rejects(chatRoute(request, url, async () => stored, noBody), { status: 503 })
})

test('rejects a response containing audio metadata with incompatible file bytes', async () => {
  const relay = createChatMediaRelay(async () => Response.json({ ...remoteFile, base64: Buffer.from('not ogg').toString('base64') }))
  await assert.rejects(chatRoute(request, url, async () => stored, noBody, undefined, undefined,
    lookup => relay('user-test-token', lookup)), { status: 422 })
})
