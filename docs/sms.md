# SMS Channel

NanoClaw can receive and send text-only SMS through Twilio Programmable Messaging.

## Environment

Set these in `.env`:

```bash
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...

# Use either a direct sender number or a Messaging Service.
TWILIO_FROM_NUMBER=+15551234567
# TWILIO_MESSAGING_SERVICE_SID=MG...

SMS_WEBHOOK_PORT=3001
SMS_WEBHOOK_PATH=/sms
SMS_PUBLIC_WEBHOOK_URL=https://your-host.example.com/sms
TWILIO_VALIDATE_SIGNATURE=true
```

`SMS_PUBLIC_WEBHOOK_URL` should match the exact public URL configured in Twilio.
It is required for reliable request-signature validation behind a proxy.

## Twilio Webhook

Configure the Twilio number or Messaging Service inbound webhook:

```text
POST https://your-host.example.com/sms
```

The adapter responds immediately with an empty TwiML response and routes the
message through NanoClaw asynchronously.

## Register A Phone Number

Wire a phone number to an agent group with the normal register step:

```bash
pnpm exec tsx setup/index.ts --step register -- \
  --platform-id +15551234567 \
  --name "Alex SMS" \
  --folder my-agent-folder \
  --channel sms \
  --no-trigger-required
```

SMS is a non-threaded direct-message channel. Replies go back to the originating
phone number.

## Current Limits

- Text only. Inbound MMS metadata is preserved, but media is not downloaded.
- Interactive cards are rendered as plain text. There is not yet a numeric
  reply parser that maps "1" or "2" back into `ask_question` button actions.
- Delivery uses Twilio's REST API directly; no Twilio SDK dependency is needed.
