import { getDb } from './connection.js';

export interface SmsStateStore {
  isOptedOut(phoneNumber: string): boolean;
  recordOptOut(phoneNumber: string, optOutType: string): void;
  clearOptOut(phoneNumber: string): void;
  getSentChunk(deliveryKey: string, chunkIndex: number): string | undefined;
  recordSentChunk(deliveryKey: string, chunkIndex: number, twilioSid: string): void;
}

export const dbSmsStateStore: SmsStateStore = {
  isOptedOut(phoneNumber: string): boolean {
    const row = getDb().prepare('SELECT 1 FROM sms_opt_outs WHERE phone_number = ? LIMIT 1').get(phoneNumber) as
      | { '1': number }
      | undefined;
    return row !== undefined;
  },

  recordOptOut(phoneNumber: string, optOutType: string): void {
    getDb()
      .prepare(
        `INSERT INTO sms_opt_outs (phone_number, opt_out_type, opted_out_at, updated_at)
         VALUES (?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(phone_number) DO UPDATE SET
           opt_out_type = excluded.opt_out_type,
           updated_at = excluded.updated_at`,
      )
      .run(phoneNumber, optOutType);
  },

  clearOptOut(phoneNumber: string): void {
    getDb().prepare('DELETE FROM sms_opt_outs WHERE phone_number = ?').run(phoneNumber);
  },

  getSentChunk(deliveryKey: string, chunkIndex: number): string | undefined {
    const row = getDb()
      .prepare('SELECT twilio_sid FROM sms_message_chunks WHERE delivery_key = ? AND chunk_index = ?')
      .get(deliveryKey, chunkIndex) as { twilio_sid: string } | undefined;
    return row?.twilio_sid;
  },

  recordSentChunk(deliveryKey: string, chunkIndex: number, twilioSid: string): void {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO sms_message_chunks (delivery_key, chunk_index, twilio_sid, sent_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(deliveryKey, chunkIndex, twilioSid);
  },
};

export function createMemorySmsStateStore(): SmsStateStore {
  const optOuts = new Map<string, string>();
  const sentChunks = new Map<string, string>();

  return {
    isOptedOut(phoneNumber: string): boolean {
      return optOuts.has(phoneNumber);
    },

    recordOptOut(phoneNumber: string, optOutType: string): void {
      optOuts.set(phoneNumber, optOutType);
    },

    clearOptOut(phoneNumber: string): void {
      optOuts.delete(phoneNumber);
    },

    getSentChunk(deliveryKey: string, chunkIndex: number): string | undefined {
      return sentChunks.get(`${deliveryKey}:${chunkIndex}`);
    },

    recordSentChunk(deliveryKey: string, chunkIndex: number, twilioSid: string): void {
      sentChunks.set(`${deliveryKey}:${chunkIndex}`, twilioSid);
    },
  };
}
