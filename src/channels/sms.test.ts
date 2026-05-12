import crypto from 'crypto';

import { describe, expect, it } from 'vitest';

import {
  createSmsAdapter,
  extractSmsText,
  parseTwilioInbound,
  sendTwilioSms,
  splitSmsText,
  twilioInboundToMessage,
  validateTwilioSignature,
  type SmsConfig,
} from './sms.js';

function baseConfig(overrides: Partial<SmsConfig> = {}): SmsConfig {
  return {
    accountSid: 'AC123',
    authToken: 'secret',
    fromNumber: '+15550001111',
    webhookPort: 0,
    webhookPath: '/sms',
    validateSignature: true,
    maxBodyLength: 1530,
    ...overrides,
  };
}

describe('sms channel helpers', () => {
  it('parses Twilio inbound webhook fields into NanoClaw content', () => {
    const inbound = parseTwilioInbound(
      new URLSearchParams({
        MessageSid: 'SM123',
        From: '+15551234567',
        To: '+15557654321',
        Body: 'hello',
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.com/media/ME123',
        MediaContentType0: 'image/jpeg',
        OptOutType: 'HELP',
      }),
    );

    expect(inbound).toEqual({
      messageSid: 'SM123',
      from: '+15551234567',
      to: '+15557654321',
      body: 'hello',
      numMedia: 1,
      media: [{ url: 'https://api.twilio.com/media/ME123', contentType: 'image/jpeg' }],
      optOutType: 'HELP',
    });

    const message = twilioInboundToMessage(inbound);
    expect(message.id).toBe('SM123');
    expect(message.kind).toBe('chat');
    expect(message.isMention).toBe(true);
    expect(message.isGroup).toBe(false);
    expect(message.content).toMatchObject({
      text: 'hello',
      sender: '+15551234567',
      senderId: '+15551234567',
      provider: 'twilio',
    });
  });

  it('renders supported outbound payloads as SMS text', () => {
    expect(extractSmsText({ kind: 'chat', content: { text: 'hello' } })).toBe('hello');
    expect(extractSmsText({ kind: 'chat', content: { markdown: '*hello*' } })).toBe('*hello*');
    expect(
      extractSmsText({
        kind: 'chat',
        content: {
          type: 'ask_question',
          title: 'Pick one',
          question: 'Which option?',
          options: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
        },
      }),
    ).toBe('Pick one\n\nWhich option?\n\n1. A\n2. B');
    expect(
      extractSmsText({
        kind: 'chat',
        content: {
          type: 'card',
          fallbackText: 'Fallback copy',
          card: { title: 'Ignored when fallback exists' },
        },
      }),
    ).toBe('Fallback copy');
  });

  it('splits long SMS bodies on sensible boundaries', () => {
    expect(splitSmsText('one two three four', 8)).toEqual(['one two', 'three', 'four']);
    expect(splitSmsText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('validates Twilio webhook signatures', () => {
    const url = 'https://example.com/sms';
    const params = new URLSearchParams({
      From: '+15551234567',
      Body: 'hello',
      MessageSid: 'SM123',
    });
    const signedPayload =
      url +
      [...params.keys()]
        .sort()
        .map((key) => `${key}${params.get(key)}`)
        .join('');
    const signature = crypto.createHmac('sha1', 'secret').update(signedPayload).digest('base64');

    expect(validateTwilioSignature('secret', url, params, signature)).toBe(true);
    expect(validateTwilioSignature('wrong', url, params, signature)).toBe(false);
  });
});

describe('sms channel delivery', () => {
  it('posts outbound messages to Twilio with From number auth', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ sid: 'SMout' }), { status: 201 });
    };

    const sid = await sendTwilioSms(baseConfig({ fetchImpl }), '+15551234567', 'hello');

    expect(sid).toBe('SMout');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('AC123:secret').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(String(calls[0].init.body)).toBe('To=%2B15551234567&Body=hello&From=%2B15550001111');
  });

  it('uses MessagingServiceSid when configured', async () => {
    const calls: Array<{ body: string }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push({ body: String(init?.body) });
      return new Response(JSON.stringify({ sid: 'SMout' }), { status: 201 });
    };

    await sendTwilioSms(
      baseConfig({
        fromNumber: undefined,
        messagingServiceSid: 'MG123',
        fetchImpl,
      }),
      '+15551234567',
      'hello',
    );

    expect(calls[0].body).toBe('To=%2B15551234567&Body=hello&MessagingServiceSid=MG123');
  });

  it('adapter deliver splits long messages and returns the first Twilio id', async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(new URLSearchParams(String(init?.body)).get('Body') || '');
      return new Response(JSON.stringify({ sid: `SM${bodies.length}` }), { status: 201 });
    };
    const adapter = createSmsAdapter(baseConfig({ fetchImpl, maxBodyLength: 5 }));

    const sid = await adapter.deliver('+15551234567', null, {
      kind: 'chat',
      content: { text: 'hello world' },
    });

    expect(sid).toBe('SM1');
    expect(bodies).toEqual(['hello', 'world']);
  });
});
