import type { InboxAccount, InboxReplyWindow } from './contracts.ts'

export const INBOX_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000

// Called with trusted provider dates and server time; never receipt time or UI time.
// The database equivalent is tested against these decisions at the exact boundary.
export function evaluateReplyWindow(
  lastInboundAt: string | null,
  now: Date,
  accountState: InboxAccount['state'],
  options?: {channel:'instagram'|'whatsapp';humanAgentEnabled:boolean;manualText:boolean},
): InboxReplyWindow {
  const current = now.getTime()
  if (!Number.isFinite(current)) throw new RangeError('Invalid server time')
  const evaluatedAt = now.toISOString()
  const inbound = lastInboundAt === null ? null : Date.parse(lastInboundAt)
  const invalid = inbound !== null && (!Number.isFinite(inbound) || inbound > current)
  const expiresAt = inbound === null || invalid ? null : new Date(inbound + INBOX_REPLY_WINDOW_MS).toISOString()
  const reason = accountState !== 'connected' ? 'disconnected'
    : inbound === null ? 'missing_inbound'
    : invalid ? 'invalid_inbound'
    : current >= inbound + INBOX_REPLY_WINDOW_MS ? 'expired' : 'open'
  if (reason==='expired' && inbound!==null && options?.channel==='instagram' && options.humanAgentEnabled && options.manualText) {
    const end = inbound + 7*INBOX_REPLY_WINDOW_MS
    if (current < end) return {canReply:true, reason:'open', mode:'human_agent', expiresAt:new Date(end).toISOString(),evaluatedAt}
  }
  return { canReply: reason === 'open', reason, mode:reason==='open'?'standard':'closed', expiresAt, evaluatedAt }
}
