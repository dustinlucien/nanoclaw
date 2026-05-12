/**
 * SMS channel backed by Twilio Programmable Messaging.
 *
 * Text-only MVP:
 *   - Inbound: Twilio webhook POST -> NanoClaw inbound chat message.
 *   - Outbound: NanoClaw message -> Twilio Messages REST API.
 *   - Conversation model: one phone number = one non-threaded messaging group.
 *
 * Required env:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID
 *
 * Optional env:
 *   SMS_WEBHOOK_PORT=3001
 *   SMS_WEBHOOK_PATH=/sms
 *   SMS_PUBLIC_WEBHOOK_URL=https://example.com/sms
 *   TWILIO_VALIDATE_SIGNATURE=true|false
 *   TWILIO_MAX_BODY_LENGTH=1530
 */
import crypto from 'crypto';
import http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'sms';
const DEFAULT_WEBHOOK_PORT = 3001;
const DEFAULT_WEBHOOK_PATH = '/sms';
const DEFAULT_MAX_BODY_LENGTH = 1530;
const TWILIO_MESSAGES_API_VERSION = '2010-04-01';

type FetchLike = typeof fetch;

export interface SmsConfig {
  accountSid: string;
  authToken: string;
  fromNumber?: string;
  messagingServiceSid?: string;
  webhookPort: number;
  webhookPath: string;
  publicWebhookUrl?: string;
  validateSignature: boolean;
  maxBodyLength: number;
  fetchImpl?: FetchLike;
}

export interface TwilioInbound {
  messageSid: string;
  from: string;
  to: string;
  body: string;
  numMedia: number;
  media: Array<{ url: string; contentType?: string }>;
  optOutType?: string;
}

function envValue(env: Record<string, string>, key: string): string | undefined {
  return process.env[key] || env[key] || undefined;
}

function envBool(env: Record<string, string>, key: string, fallback: boolean): boolean {
  const raw = envValue(env, key);
  if (raw === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function envInt(env: Record<string, string>, key: string, fallback: number): number {
  const raw = envValue(env, key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readSmsConfig(): SmsConfig | null {
  const env = readEnvFile([
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'TWILIO_MESSAGING_SERVICE_SID',
    'SMS_WEBHOOK_PORT',
    'SMS_WEBHOOK_PATH',
    'SMS_PUBLIC_WEBHOOK_URL',
    'TWILIO_VALIDATE_SIGNATURE',
    'TWILIO_MAX_BODY_LENGTH',
  ]);

  const accountSid = envValue(env, 'TWILIO_ACCOUNT_SID');
  const authToken = envValue(env, 'TWILIO_AUTH_TOKEN');
  const fromNumber = envValue(env, 'TWILIO_FROM_NUMBER');
  const messagingServiceSid = envValue(env, 'TWILIO_MESSAGING_SERVICE_SID');

  if (!accountSid || !authToken || (!fromNumber && !messagingServiceSid)) {
    return null;
  }

  const webhookPath = envValue(env, 'SMS_WEBHOOK_PATH') || DEFAULT_WEBHOOK_PATH;
  return {
    accountSid,
    authToken,
    fromNumber,
    messagingServiceSid,
    webhookPort: envInt(env, 'SMS_WEBHOOK_PORT', DEFAULT_WEBHOOK_PORT),
    webhookPath: webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`,
    publicWebhookUrl: envValue(env, 'SMS_PUBLIC_WEBHOOK_URL'),
    validateSignature: envBool(env, 'TWILIO_VALIDATE_SIGNATURE', true),
    maxBodyLength: envInt(env, 'TWILIO_MAX_BODY_LENGTH', DEFAULT_MAX_BODY_LENGTH),
  };
}

export function parseTwilioInbound(params: URLSearchParams): TwilioInbound {
  const numMediaRaw = Number.parseInt(params.get('NumMedia') || '0', 10);
  const numMedia = Number.isFinite(numMediaRaw) && numMediaRaw > 0 ? numMediaRaw : 0;
  const media: TwilioInbound['media'] = [];

  for (let i = 0; i < numMedia; i++) {
    const url = params.get(`MediaUrl${i}`);
    if (!url) continue;
    media.push({
      url,
      contentType: params.get(`MediaContentType${i}`) || undefined,
    });
  }

  return {
    messageSid: params.get('MessageSid') || `sms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: params.get('From') || '',
    to: params.get('To') || '',
    body: params.get('Body') || '',
    numMedia,
    media,
    optOutType: params.get('OptOutType') || undefined,
  };
}

export function twilioInboundToMessage(inbound: TwilioInbound): InboundMessage {
  return {
    id: inbound.messageSid,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    isMention: true,
    isGroup: false,
    content: {
      text: inbound.body,
      sender: inbound.from,
      senderId: inbound.from,
      senderName: inbound.from,
      from: inbound.from,
      to: inbound.to,
      provider: 'twilio',
      optOutType: inbound.optOutType,
      media: inbound.media,
      numMedia: inbound.numMedia,
    },
  };
}

export function extractSmsText(message: OutboundMessage): string | null {
  const content = message.content;
  if (typeof content === 'string') return content.trim() || null;
  if (!content || typeof content !== 'object') return null;

  const payload = content as Record<string, unknown>;
  if (payload.type === 'ask_question') {
    return renderAskQuestion(payload);
  }
  if (payload.type === 'card') {
    return renderCard(payload);
  }

  const text = typeof payload.text === 'string' ? payload.text : undefined;
  const markdown = typeof payload.markdown === 'string' ? payload.markdown : undefined;
  return (markdown || text || '').trim() || null;
}

function renderAskQuestion(payload: Record<string, unknown>): string | null {
  const title = typeof payload.title === 'string' ? payload.title : '';
  const question = typeof payload.question === 'string' ? payload.question : '';
  const options = Array.isArray(payload.options) ? payload.options : [];
  const renderedOptions = options
    .map((opt, idx) => {
      if (typeof opt === 'string') return `${idx + 1}. ${opt}`;
      if (!opt || typeof opt !== 'object') return null;
      const label = (opt as Record<string, unknown>).label;
      return typeof label === 'string' && label ? `${idx + 1}. ${label}` : null;
    })
    .filter((line): line is string => line !== null);
  const parts = [title, question, renderedOptions.length > 0 ? renderedOptions.join('\n') : ''].filter(Boolean);
  return parts.join('\n\n').trim() || null;
}

function renderCard(payload: Record<string, unknown>): string | null {
  const fallbackText = typeof payload.fallbackText === 'string' ? payload.fallbackText : '';
  if (fallbackText.trim()) return fallbackText.trim();

  const card = payload.card && typeof payload.card === 'object' ? (payload.card as Record<string, unknown>) : {};
  const title = typeof card.title === 'string' ? card.title : '';
  const description = typeof card.description === 'string' ? card.description : '';
  const children = Array.isArray(card.children)
    ? card.children
        .map((child) => {
          if (typeof child === 'string') return child;
          if (!child || typeof child !== 'object') return null;
          const text = (child as Record<string, unknown>).text;
          return typeof text === 'string' ? text : null;
        })
        .filter((line): line is string => line !== null)
    : [];

  return [title, description, ...children].filter(Boolean).join('\n\n').trim() || null;
}

export function splitSmsText(text: string, limit: number): string[] {
  if (limit < 1) throw new Error('SMS body limit must be positive');
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function validateTwilioSignature(
  authToken: string,
  publicUrl: string,
  params: URLSearchParams,
  signature: string | undefined,
): boolean {
  if (!signature) return false;

  const signedPayload =
    publicUrl +
    [...new Set([...params.keys()])]
      .sort()
      .map((key) => `${key}${params.getAll(key).join('')}`)
      .join('');
  const expected = crypto.createHmac('sha1', authToken).update(signedPayload).digest('base64');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function sendTwilioSms(config: SmsConfig, to: string, body: string): Promise<string | undefined> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    To: to,
    Body: body,
  });

  if (config.messagingServiceSid) {
    params.set('MessagingServiceSid', config.messagingServiceSid);
  } else if (config.fromNumber) {
    params.set('From', config.fromNumber);
  }

  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
  const url = `https://api.twilio.com/${TWILIO_MESSAGES_API_VERSION}/Accounts/${encodeURIComponent(
    config.accountSid,
  )}/Messages.json`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Twilio SMS send failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const json = (await response.json().catch(() => ({}))) as { sid?: string };
  return json.sid;
}

export function createSmsAdapter(config: SmsConfig): ChannelAdapter {
  let server: http.Server | null = null;
  let setupConfig: ChannelSetup | null = null;

  const adapter: ChannelAdapter = {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(hostConfig: ChannelSetup): Promise<void> {
      setupConfig = hostConfig;
      server = http.createServer((req, res) => {
        void handleWebhook(req, res, config, hostConfig);
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(config.webhookPort, '0.0.0.0', () => resolve());
      });
      log.info('SMS webhook listening', {
        port: config.webhookPort,
        path: config.webhookPath,
        signatureValidation: config.validateSignature,
      });
    },

    async teardown(): Promise<void> {
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
      setupConfig = null;
    },

    isConnected(): boolean {
      return setupConfig !== null && server !== null;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const text = extractSmsText(message);
      if (!text) return undefined;

      let firstId: string | undefined;
      for (const chunk of splitSmsText(text, config.maxBodyLength)) {
        const sid = await sendTwilioSms(config, platformId, chunk);
        firstId ??= sid;
      }
      return firstId;
    },
  };

  return adapter;
}

async function handleWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: SmsConfig,
  hostConfig: ChannelSetup,
): Promise<void> {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method !== 'POST' || requestUrl.pathname !== config.webhookPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const body = await readBody(req);
  const params = new URLSearchParams(body);
  if (config.validateSignature) {
    const publicUrl = config.publicWebhookUrl || requestPublicUrl(req, requestUrl.pathname);
    const signature = headerString(req.headers['x-twilio-signature']);
    if (!validateTwilioSignature(config.authToken, publicUrl, params, signature)) {
      log.warn('Rejected SMS webhook with invalid Twilio signature', { publicUrl });
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
  }

  const inbound = parseTwilioInbound(params);
  if (!inbound.from) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing From');
    return;
  }

  try {
    await hostConfig.onInbound(inbound.from, null, twilioInboundToMessage(inbound));
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end('<Response></Response>');
  } catch (err) {
    log.error('Failed to route SMS webhook', { err });
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function requestPublicUrl(req: http.IncomingMessage, path: string): string {
  const proto = headerString(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim() || 'http';
  const host = headerString(req.headers['x-forwarded-host'])?.split(',')[0]?.trim() || req.headers.host || 'localhost';
  return `${proto}://${host}${path}`;
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

registerChannelAdapter(CHANNEL_TYPE, {
  factory: () => {
    const config = readSmsConfig();
    if (!config) return null;
    return createSmsAdapter(config);
  },
});
