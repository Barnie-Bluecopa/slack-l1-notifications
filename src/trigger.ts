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

// Renders as the user's local timezone in Slack messages
function slackDate(ts: string): string {
  const unix = Math.floor(parseFloat(ts));
  return `<!date^${unix}^{date_short_pretty} at {time}|${new Date(unix * 1000).toISOString()}>`;
}

// Human-readable IST date for canvas (canvases don't support <!date^...> tokens)
function canvasDate(ts: string): string {
  return new Date(parseFloat(ts) * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }) + ' IST';
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

async function resolveUserNames(
  client: WebClient,
  userIds: string[],
  preloaded: Map<string, string> = new Map()
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>(preloaded);
  // Only call users.info for IDs not already resolved from search results.
  // Requires users:read scope — falls back silently if not yet approved.
  await Promise.all(
    userIds
      .filter(id => !nameMap.has(id))
      .map(async id => {
        try {
          const res = await client.users.info({ user: id });
          const p = res.user?.profile;
          const name = (p?.display_name || p?.real_name || res.user?.name) as string | undefined;
          if (name) nameMap.set(id, name);
        } catch {
          // scope not yet granted — leave unresolved, canvas will show generic label
        }
      })
  );
  return nameMap;
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
): Promise<{ mentions: Mention[]; nameCache: Map<string, string> }> {
  const oldestTs = Math.floor((Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000) / 1000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const search = await (client as any).search.messages({
    query: `@${usergroupHandle}`,
    count: 100,
    sort: 'timestamp',
    sort_dir: 'desc',
  });

  // search.messages returns user_profile on each match — extract names for free,
  // no users:read scope required.
  const nameCache = new Map<string, string>();
  const results: Mention[] = [];

  for (const match of (search.messages?.matches ?? [])) {
    // Build name cache regardless of age/channel filter
    if (match.user) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prof = (match as any).user_profile;
      const name = prof?.display_name || prof?.real_name || match.username;
      if (name) nameCache.set(match.user as string, name as string);
    }

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
  return { mentions: results, nameCache };
}

// ── Channel message (Block Kit) ──────────────────────────────────────────────

function buildBlocks(
  mentions: Mention[],
  memberMentions: string,
  istStr: string
): { blocks: KnownBlock[]; text: string } {
  const attended = mentions.filter(m => m.attended);
  const unattended = mentions.filter(m => !m.attended);
  const blocks: KnownBlock[] = [];

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

  if (attended.length > 0) {
    const lines = attended.map((m, i) => {
      const responders = m.attendedBy.map(id => `<@${id}>`).join(', ');
      const tickets = extractTickets(m.text);
      const ticketSuffix = tickets.length > 0
        ? `  ·  ${tickets.map(t => `<${JIRA_BASE}/${t}|${t}>`).join(' | ')}`
        : '';
      return `:large_green_circle: *${unattended.length + i + 1}.* _${m.userName}_ in <#${m.channelId}|${m.channelName}> → attended by ${responders}${ticketSuffix}  ·  <${m.permalink}|view>`;
    });

    // Slack block text capped at 3000 chars — chunk lines as needed
    const chunks: string[] = [];
    let current = `:white_check_mark: *ATTENDED — Being Handled (${attended.length})*\n\n`;
    for (const line of lines) {
      if (current.length + line.length + 1 > 2800) {
        chunks.push(current.trimEnd());
        current = line + '\n';
      } else {
        current += line + '\n';
      }
    }
    if (current.trimEnd()) chunks.push(current.trimEnd());

    for (const chunk of chunks) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
    }
    blocks.push({ type: 'divider' });
  }

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

// ── Canvas report ────────────────────────────────────────────────────────────

function buildCanvasMarkdown(
  mentions: Mention[],
  l1MemberIds: string[],
  userNames: Map<string, string>,
  usergroupHandle: string,
  istStr: string
): string {
  const attended = mentions.filter(m => m.attended);
  const unattended = mentions.filter(m => !m.attended);
  const lines: string[] = [];

  lines.push('# 📡 L1 Support Mention Tracker — Live Dashboard');
  lines.push('');
  lines.push(`**Last scanned: ${istStr}** · Total: **${mentions.length}** · :red_circle: Unattended: **${unattended.length}** · :large_green_circle: Attended: **${attended.length}** · Lookback: ${LOOKBACK_DAYS} days`);
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('## :busts_in_silhouette: Current @l1-support Team Members');
  lines.push('');
  const resolvedMembers = l1MemberIds.map(id => userNames.get(id)).filter(Boolean) as string[];
  if (resolvedMembers.length === l1MemberIds.length) {
    lines.push(resolvedMembers.map(n => `@${n}`).join('   '));
  } else if (resolvedMembers.length > 0) {
    lines.push(resolvedMembers.map(n => `@${n}`).join('   ') + `  _(+ ${l1MemberIds.length - resolvedMembers.length} more)_`);
  } else {
    lines.push(`@${usergroupHandle} — ${l1MemberIds.length} members`);
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('## :rotating_light: Unattended Mentions — Action Required');
  lines.push('');

  if (unattended.length === 0) {
    lines.push(':white_check_mark: No unattended mentions — all handled!');
    lines.push('');
  } else {
    unattended.forEach((m, i) => {
      const title = extractTitle(m.text);
      const tickets = extractTickets(m.text);
      const snippet = m.text.length > 300 ? m.text.slice(0, 297) + '…' : m.text;

      lines.push(`### ${i + 1}. #${m.channelName} — ${title}`);
      lines.push('');
      lines.push(`* **From:** ${m.userName}`);
      lines.push(`* **Channel:** #${m.channelName}`);
      lines.push(`* **Time:** ${canvasDate(m.messageTs)}`);
      lines.push(`* **Status:** :red_circle: **UNATTENDED — No L1 response**`);
      lines.push(`* **Message:** *"${snippet}"*`);
      if (tickets.length > 0) {
        lines.push(`* **Tickets:** ${tickets.map(t => `[${t}](${JIRA_BASE}/${t})`).join(' | ')}`);
      }
      lines.push(`* **Link:** [View in Slack](${m.permalink})`);
      lines.push('');
    });
  }

  lines.push('---');
  lines.push('');
  lines.push('## :white_check_mark: Attended Mentions — Being Handled');
  lines.push('');

  if (attended.length === 0) {
    lines.push('_No attended mentions in the lookback window._');
    lines.push('');
  } else {
    attended.forEach((m, i) => {
      const title = extractTitle(m.text);
      const tickets = extractTickets(m.text);
      const snippet = m.text.length > 300 ? m.text.slice(0, 297) + '…' : m.text;
      const responders = m.attendedBy.map(id => `@${userNames.get(id) ?? 'team member'}`).join(', ');

      lines.push(`### ${unattended.length + i + 1}. #${m.channelName} — ${title}`);
      lines.push('');
      lines.push(`* **From:** ${m.userName}`);
      lines.push(`* **Channel:** #${m.channelName}`);
      lines.push(`* **Time:** ${canvasDate(m.messageTs)}`);
      lines.push(`* **Status:** :large_green_circle: **Attended by** ${responders}`);
      lines.push(`* **Message:** *"${snippet}"*`);
      if (tickets.length > 0) {
        lines.push(`* **Tickets:** ${tickets.map(t => `[${t}](${JIRA_BASE}/${t})`).join(' | ')}`);
      }
      lines.push(`* **Link:** [View in Slack](${m.permalink})`);
      lines.push('');
    });
  }

  lines.push('---');
  lines.push('');
  lines.push('## :bar_chart: Quick Stats');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Total @l1-support mentions (last ${LOOKBACK_DAYS} days) | ${mentions.length} |`);
  lines.push(`| :large_green_circle: Attended by L1 team | ${attended.length} |`);
  lines.push(`| :red_circle: Unattended | ${unattended.length} |`);
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('## :gear: How This Works');
  lines.push('');
  lines.push(`* **Scans** all public and private channels for \`@${usergroupHandle}\` mentions`);
  lines.push('* **Checks threads** for responses from current @l1-support group members (dynamic — reflects real-time membership)');
  lines.push('* **Visual cues:** :large_green_circle: Attended (with responder name) · :red_circle: Unattended');
  lines.push('* Auto-updated by GitHub Actions every 45 minutes — no manual refresh needed');

  return lines.join('\n');
}

async function refreshCanvas(
  client: WebClient,
  canvasId: string,
  markdown: string,
  memberIds: string[]
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (client as any).canvases;

  // ── Section-type sweeps (Slack: max 3 types per call) ─────────────────────
  const typeChunks = [
    ['any_header', 'bullet_list', 'ordered_list'],
    ['divider', 'table', 'todo'],
    ['quote', 'code_block', 'media'],
    ['paragraph', 'rich_text', 'callout'],
    ['people', 'person', 'image'],
    ['embed', 'link', 'canvas_link'],
  ];

  // ── Text-content sweeps ────────────────────────────────────────────────────
  // ' '  (single space) catches every text section that has any words.
  // memberIds catch people-card sections that internally store a user ID.
  // Named strings catch known content from any historical version of the canvas.
  const textSweeps = [
    ' ',
    ...memberIds,
    'Tracker', 'scanned', 'Unattended', 'Attended', 'l1-support',
    'local time', 'How This', 'Quick Stats', 'Support',
  ];

  // 4 passes: pass 1 finds the bulk, passes 2-4 catch anything only visible
  // after earlier deletions expose new top-level sections.
  for (let pass = 0; pass < 4; pass++) {
    const ids = new Set<string>();

    for (const types of typeChunks) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await api.sections.lookup({ canvas_id: canvasId, criteria: { section_types: types } });
        for (const s of (res.sections ?? [])) if (s.id) ids.add(s.id as string);
      } catch { /* unsupported type — skip */ }
    }

    for (const text of textSweeps) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await api.sections.lookup({ canvas_id: canvasId, criteria: { contains_text: text } });
        for (const s of (res.sections ?? [])) if (s.id) ids.add(s.id as string);
      } catch { /* ignore */ }
    }

    if (ids.size === 0) {
      console.log(`  Pass ${pass + 1}: canvas is empty — done clearing`);
      break;
    }
    console.log(`  Pass ${pass + 1}: clearing ${ids.size} section(s)...`);
    for (const id of ids) {
      try {
        await api.edit({ canvas_id: canvasId, changes: [{ operation: 'delete', section_id: id }] });
      } catch { /* already gone */ }
    }
  }

  await api.edit({
    canvas_id: canvasId,
    changes: [{ operation: 'insert_at_start', document_content: { type: 'markdown', markdown } }],
  });
  console.log('  Canvas content replaced');
}

// ── Entry point ──────────────────────────────────────────────────────────────

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
  const canvasId = process.env.SLACK_CANVAS_ID; // optional — skip canvas if not set

  const client = new WebClient(token);

  console.log(`[${istStr}] Resolving @l1-support members...`);
  const { ids: l1MemberIds, handle } = await getL1Members(client, usergroupId);
  console.log(`[${istStr}] ${l1MemberIds.length} members in @${handle}`);

  console.log(`[${istStr}] Scanning for @${handle} mentions...`);
  const { mentions, nameCache } = await scanMentions(client, l1MemberIds, handle, channel);
  const unattendedCount = mentions.filter(m => !m.attended).length;
  console.log(`[${istStr}] ${mentions.length} mentions found, ${unattendedCount} unattended`);

  const memberMentions = l1MemberIds.map(id => `<@${id}>`).join(' ');

  // Post channel message
  const { blocks, text } = buildBlocks(mentions, memberMentions, istStr);
  await client.chat.postMessage({ channel, text, blocks });
  console.log(`[${istStr}] Posted summary to ${channel}`);

  // Refresh canvas (best-effort — failure doesn't break channel message)
  if (canvasId) {
    console.log(`[${istStr}] Refreshing canvas ${canvasId}...`);
    try {
      const allUserIds = [...new Set([...l1MemberIds, ...mentions.flatMap(m => m.attendedBy)])];
      const userNames = await resolveUserNames(client, allUserIds, nameCache);
      const canvasMarkdown = buildCanvasMarkdown(mentions, l1MemberIds, userNames, handle, istStr);
      await refreshCanvas(client, canvasId, canvasMarkdown, l1MemberIds);
      console.log(`[${istStr}] Canvas refreshed`);
    } catch (err: unknown) {
      console.error(`[${istStr}] Canvas refresh failed (channel message was already posted): ${(err as Error).message ?? err}`);
    }
  }
}

main().catch(err => {
  console.error(err.message ?? err);
  process.exit(1);
});
