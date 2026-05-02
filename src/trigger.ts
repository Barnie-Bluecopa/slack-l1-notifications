import { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/web-api';

const LOOKBACK_DAYS = 3;
const INTERVAL_MINUTES = 45;
const START_HOUR_IST = 8;
const END_HOUR_IST = 22;
const JITTER_TOLERANCE = 2;
const JIRA_BASE = 'https://assetten.atlassian.net/browse';

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

// Renders as the user's local time in Slack
function slackDate(ts: string): string {
  const unix = Math.floor(parseFloat(ts));
  return `<!date^${unix}^{date_short_pretty} at {time}|${new Date(unix * 1000).toISOString()}>`;
}

// First meaningful sentence from the message, stripped of @l1-support prefix
function extractTitle(text: string): string {
  const cleaned = text.replace(/@l1-support\s*/gi, '').replace(/\s+/g, ' ').trim();
  const first = cleaned.split(/[.!?\n]/)[0].trim();
  const title = first.length > 0 ? first : cleaned;
  return title.length > 65 ? title.slice(0, 62) + '…' : title;
}

// Extracts Jira ticket numbers (SUP-, CI-, REL-, IMP-)
function extractTickets(text: string): string[] {
  return [...new Set((text.match(/\b(?:SUP|CI|REL|IMP)-\d+/gi) ?? []).map(t => t.toUpperCase()))];
}

async function getL1Members(
  client: WebClient,
  usergroupId: string
): Promise<{ ids: string[]; handle: string }> {
  const [usersResult, groupsResult] = await Promise.all([
    client.usergroups.users.list({ usergroup: usergroupId }),
    client.usergroups.list({ include_users: false }),
  ]);
  const ids = (usersResult.users as string[]) ?? [];
  const group = groupsResult.usergroups?.find(g => g.id === usergroupId);
  const handle = group?.handle ?? 'l1-support';
  return { ids, handle };
}

interface Mention {
  channelId: string;
  channelName: string;
  messageTs: string;
  userName: string;
  text: string;
  permalink: string;
  attended: boolean;
  attendedBy: string[];
}

async function checkThread(
  client: WebClient,
  channelId: string,
  messageTs: string,
  l1MemberIds: string[]
): Promise<{ attended: boolean; attendedBy: string[] }> {
  try {
    const replies = await client.conversations.replies({
      channel: channelId,
      ts: messageTs,
      limit: 100,
    });
    const attendedBy: string[] = [];
    for (const msg of (replies.messages ?? []).slice(1)) {
      if (msg.user && l1MemberIds.includes(msg.user)) {
        attendedBy.push(msg.user);
      }
    }
    return { attended: attendedBy.length > 0, attendedBy: [...new Set(attendedBy)] };
  } catch {
    return { attended: false, attendedBy: [] };
  }
}

async function scanMentions(
  client: WebClient,
  l1MemberIds: string[],
  usergroupHandle: string,
  reportingChannelId: string
): Promise<Mention[]> {
  const oldestTs = Math.floor((Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000) / 1000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const search = await (client as any).search.messages({
    query: `@${usergroupHandle}`,
    count: 100,
    sort: 'timestamp',
    sort_dir: 'desc',
  });

  const results: Mention[] = [];
  for (const match of (search.messages?.matches ?? [])) {
    if (!match.ts || parseFloat(match.ts) < oldestTs) continue;
    if (match.channel?.id === reportingChannelId) continue;

    const { attended, attendedBy } = await checkThread(
      client,
      match.channel?.id ?? '',
      match.ts,
      l1MemberIds
    );

    results.push({
      channelId: match.channel?.id ?? '',
      channelName: match.channel?.name ?? 'unknown',
      messageTs: match.ts,
      userName: match.username ?? 'Unknown',
      text: (match.text ?? '')
        .replace(/<!subteam\^[^>]+>/g, '@l1-support')
        .replace(/<[^>]+>/g, '')
        .trim(),
      permalink: match.permalink ?? '',
      attended,
      attendedBy,
    });
  }
  return results;
}

function buildBlocks(
  mentions: Mention[],
  memberMentions: string,
  istStr: string
): { blocks: KnownBlock[]; text: string } {
  const attended = mentions.filter(m => m.attended);
  const unattended = mentions.filter(m => !m.attended);
  const blocks: KnownBlock[] = [];

  // ── Header ──────────────────────────────────────────────────────────────
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '📡 L1 Support Mention Tracker', emoji: true },
  });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Last scanned: *${istStr}*  ·  Total: *${mentions.length}*  ·  :red_circle: Unattended: *${unattended.length}*  ·  :large_green_circle: Attended: *${attended.length}*  ·  Lookback: ${LOOKBACK_DAYS} days`,
    }],
  });
  blocks.push({ type: 'divider' });

  // ── Unattended ──────────────────────────────────────────────────────────
  if (unattended.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:rotating_light: *UNATTENDED — Action Required (${unattended.length})*` },
    });

    unattended.forEach((m, i) => {
      const title = extractTitle(m.text);
      const tickets = extractTickets(m.text);
      const ticketLine = tickets.length > 0
        ? `\n• *Tickets:* ${tickets.map(t => `<${JIRA_BASE}/${t}|${t}>`).join('  |  ')}`
        : '';
      const snippet = m.text.length > 200 ? m.text.slice(0, 197) + '…' : m.text;

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*${i + 1}. <#${m.channelId}|${m.channelName}> — ${title}*`,
            `• *From:* ${m.userName}   • *Time:* ${slackDate(m.messageTs)}`,
            `• *Status:* :red_circle: *UNATTENDED — No L1 response yet*`,
            `• *Message:* _"${snippet}"_`,
            ticketLine ? ticketLine.slice(1) : null,
            `• :link: <${m.permalink}|View thread>`,
          ].filter(Boolean).join('\n'),
        },
      });
    });

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:rotating_light: *Action needed:* ${memberMentions} — Please attend to the above.` },
    });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: ':white_check_mark: *All @l1-support mentions have been attended to.*' },
    });
  }

  blocks.push({ type: 'divider' });

  // ── Attended ────────────────────────────────────────────────────────────
  if (attended.length > 0) {
    const lines = attended.map((m, i) => {
      const responders = m.attendedBy.map(id => `<@${id}>`).join(', ');
      const tickets = extractTickets(m.text);
      const ticketSuffix = tickets.length > 0
        ? `  ·  ${tickets.map(t => `<${JIRA_BASE}/${t}|${t}>`).join(' | ')}`
        : '';
      return `:large_green_circle: *${unattended.length + i + 1}.* _${m.userName}_ in <#${m.channelId}|${m.channelName}> → attended by ${responders}${ticketSuffix}  ·  <${m.permalink}|view>`;
    });

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:white_check_mark: *ATTENDED — Being Handled (${attended.length})*\n\n${lines.join('\n')}`,
      },
    });
    blocks.push({ type: 'divider' });
  }

  // ── Quick Stats ─────────────────────────────────────────────────────────
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        ':bar_chart: *Quick Stats*',
        `• Total @l1-support mentions (last ${LOOKBACK_DAYS} days): *${mentions.length}*`,
        `:large_green_circle: Attended by L1 team: *${attended.length}*`,
        `:red_circle: Unattended: *${unattended.length}*`,
      ].join('\n'),
    },
  });

  const text = unattended.length > 0
    ? `:rotating_light: ${unattended.length} unattended @l1-support mention${unattended.length > 1 ? 's' : ''} — action required`
    : `:white_check_mark: All ${mentions.length} @l1-support mention${mentions.length !== 1 ? 's' : ''} attended to`;

  return { blocks, text };
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

  const token = process.env.SLACK_USER_TOKEN;
  if (!token) throw new Error('SLACK_USER_TOKEN is not set');
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!channel) throw new Error('SLACK_CHANNEL_ID is not set');
  const usergroupId = process.env.SLACK_L1_USERGROUP_ID;
  if (!usergroupId) throw new Error('SLACK_L1_USERGROUP_ID is not set');

  const client = new WebClient(token);

  console.log(`[${istStr}] Resolving @l1-support members...`);
  const { ids: l1MemberIds, handle } = await getL1Members(client, usergroupId);
  console.log(`[${istStr}] ${l1MemberIds.length} members in @${handle}`);

  console.log(`[${istStr}] Scanning for @${handle} mentions...`);
  const mentions = await scanMentions(client, l1MemberIds, handle, channel);
  const unattendedCount = mentions.filter(m => !m.attended).length;
  console.log(`[${istStr}] ${mentions.length} mentions found, ${unattendedCount} unattended`);

  const memberMentions = l1MemberIds.map(id => `<@${id}>`).join(' ');
  const { blocks, text } = buildBlocks(mentions, memberMentions, istStr);

  await client.chat.postMessage({ channel, text, blocks });
  console.log(`[${istStr}] Posted summary to ${channel}`);
}

main().catch(err => {
  console.error(err.message ?? err);
  process.exit(1);
});
