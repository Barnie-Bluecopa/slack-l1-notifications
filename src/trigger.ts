import { WebClient } from '@slack/web-api';
import { getAutoScanSlackMessage } from './config/index.js';

const INTERVAL_MINUTES = 45;
const START_HOUR_IST = 8;   // 8:00 AM IST
const END_HOUR_IST = 22;    // 10:00 PM IST
const JITTER_TOLERANCE = 2; // minutes — handles GitHub Actions scheduling delay

function toIST(utc: Date): Date {
  // IST = UTC + 5 hours 30 minutes
  return new Date(utc.getTime() + (5 * 60 + 30) * 60 * 1000);
}

function isTriggerTime(ist: Date): boolean {
  const day = ist.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return false;

  const h = ist.getHours();
  const m = ist.getMinutes();

  // Active window: [08:00, 22:00) IST — last trigger lands at 21:30
  if (h < START_HOUR_IST || h >= END_HOUR_IST) return false;

  const minutesSinceOpen = (h - START_HOUR_IST) * 60 + m;
  const remainder = minutesSinceOpen % INTERVAL_MINUTES;

  // Fire if within ±JITTER_TOLERANCE minutes of a 45-min mark.
  // Adjacent cron fires are 15 min apart, so no double-trigger risk.
  return remainder <= JITTER_TOLERANCE || remainder >= INTERVAL_MINUTES - JITTER_TOLERANCE;
}

async function main() {
  const ist = toIST(new Date());
  const istStr = ist.toISOString().replace('T', ' ').slice(0, 16) + ' IST';

  const force = process.env.FORCE_TRIGGER === 'true';
  console.log(`[${istStr}] force=${force} isTriggerTime=${isTriggerTime(ist)}`);

  if (!force && !isTriggerTime(ist)) {
    console.log(`[${istStr}] Not a trigger time — skipping.`);
    return;
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN is not set');

  const channel = process.env.SLACK_CHANNEL_ID;
  if (!channel) throw new Error('SLACK_CHANNEL_ID is not set');

  const client = new WebClient(token);
  const text = getAutoScanSlackMessage();

  await client.chat.postMessage({ channel, text, mrkdwn: true });

  console.log(`[${istStr}] Posted auto-scan trigger to ${channel}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
