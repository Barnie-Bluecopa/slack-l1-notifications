import { WebClient } from '@slack/web-api';

const LOOKBACK_DAYS = 3;
const INTERVAL_MINUTES = 45;
const START_HOUR_IST = 8;
const END_HOUR_IST = 22;
const JITTER_TOLERANCE = 2;

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
    // Exclude messages from the reporting channel (our own scan summaries)
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
      // Strip Slack formatting tokens for readable text
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

function buildSummary(mentions: Mention[], memberMentions: string, istStr: string): string {
  const attended = mentions.filter(m => m.attended);
  const unattended = mentions.filter(m => !m.attended);

  let msg = `:bar_chart: _L1 Support Scan Summary — ${istStr}_\n\n`;
  msg += `*${mentions.length} total @l1-support mentions* found (last ${LOOKBACK_DAYS} days).\n\n`;

  if (unattended.length > 0) {
    msg += `:red_circle: *UNATTENDED (${unattended.length})*\n\n`;
    unattended.forEach((m, i) => {
      const snippet = m.text.length > 150 ? m.text.slice(0, 150) + '…' : m.text;
      msg += `${i + 1}. _${m.userName}_ — #${m.channelName}\n`;
      msg += `> ${snippet}\n`;
      msg += `:red_circle: _No L1 response yet_ · :link: ${m.permalink}\n\n`;
    });
    msg += `:rotating_light: *Action needed:* ${memberMentions} — Please attend to the above.\n\n`;
  } else {
    msg += `:white_check_mark: All @l1-support mentions have been attended to.\n\n`;
  }

  if (attended.length > 0) {
    msg += `:large_green_circle: *ATTENDED (${attended.length})*\n`;
    attended.forEach(m => {
      const responders = m.attendedBy.map(id => `<@${id}>`).join(', ');
      msg += `• _${m.userName}_ in #${m.channelName} → ${responders}\n`;
    });
  }

  return msg;
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
  const text = buildSummary(mentions, memberMentions, istStr);

  await client.chat.postMessage({ channel, text, mrkdwn: true });
  console.log(`[${istStr}] Posted summary to ${channel}`);
}

main().catch(err => {
  console.error(err.message ?? err);
  process.exit(1);
});
