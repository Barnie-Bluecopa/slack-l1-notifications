import { WebClient } from '@slack/web-api';

const INTERVAL_MINUTES = 45;
const START_HOUR_IST = 8;   // 8:00 AM IST
const END_HOUR_IST = 22;    // 10:00 PM IST
const JITTER_TOLERANCE = 2; // minutes — handles GitHub Actions scheduling delay

function toIST(utc: Date): Date {
  return new Date(utc.getTime() + (5 * 60 + 30) * 60 * 1000);
}

function isTriggerTime(ist: Date): boolean {
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;

  const h = ist.getHours();
  const m = ist.getMinutes();

  if (h < START_HOUR_IST || h >= END_HOUR_IST) return false;

  const minutesSinceOpen = (h - START_HOUR_IST) * 60 + m;
  const remainder = minutesSinceOpen % INTERVAL_MINUTES;

  return remainder <= JITTER_TOLERANCE || remainder >= INTERVAL_MINUTES - JITTER_TOLERANCE;
}

// Formats comma-separated user IDs (e.g. "U07K5U2QJHW,U087QBEDXNC") into
// Slack mention syntax: "<@U07K5U2QJHW>, <@U087QBEDXNC>"
function formatMembers(memberIds: string): string {
  return memberIds
    .split(',')
    .map((id) => `<@${id.trim()}>`)
    .join(', ');
}

function buildMessage(memberMentions: string): string {
  return `:arrows_counterclockwise: *Auto-Scan Trigger* (every 45 min)
\`@Claude\` — Scan all Slack channels for new \`@l1-support\` mentions. For each mention, check the thread for responses from L1 team members (${memberMentions}). Post a summary here showing :large_green_circle: Attended (by whom) or :red_circle: Unattended for each. Tag L1 team on any unattended mentions.`;
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

  const memberIds = process.env.SLACK_L1_MEMBER_IDS;
  if (!memberIds) throw new Error('SLACK_L1_MEMBER_IDS is not set');

  const memberMentions = formatMembers(memberIds);
  const text = buildMessage(memberMentions);

  const client = new WebClient(token);
  await client.chat.postMessage({ channel, text, mrkdwn: true });

  console.log(`[${istStr}] Posted auto-scan trigger to ${channel}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
