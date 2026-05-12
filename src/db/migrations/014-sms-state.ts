import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'sms-state',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sms_opt_outs (
        phone_number TEXT PRIMARY KEY,
        opt_out_type TEXT NOT NULL,
        opted_out_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sms_message_chunks (
        delivery_key TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        twilio_sid TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (delivery_key, chunk_index)
      );
    `);
  },
};
