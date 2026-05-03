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
  await Promise.all(
    userIds
      .filter(id => !nameMap.has(id))
      .map(async id => {
        try {
          // users.info needs users:read scope
          const res = await client.users.info({ user: id });
          const p = res.user?.profile;
          const name = (p?.display_name || p?.real_name || res.user?.name) as string | undefined;
          if (name) nameMap.set(id, name);
        } catch {
          try {
            // users.profile.get needs users.profile:read — try as fallback
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const res2: any = await (client as any).users.profile.get({ user: id });
            const name = res2.profile?.display_name || res2.profile?.real_name as string | undefined;
            if (name) nameMap.set(id, name);
          } catch { /* neither scope available yet */ }
        }
      })
  );
  return nameMap;
}

// Supplemental name lookup: search recent messages in the channels where
// @l1-support was mentioned. L1 members reply there, so their profiles
// appear in those channel search results — no extra scope needed.
async function enrichNameCacheFromChannels(
  client: WebClient,
  targetIds: string[],
  channelNames: string[],
  nameMap: Map<string, string>
): Promise<void> {
  const missing = targetIds.filter(id => !nameMap.has(id));
  if (missing.length === 0) return;

  for (const ch of channelNames.slice(0, 5)) {
    if (missing.every(id => nameMap.has(id))) break;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await (client as any).search.messages({
        query: `in:${ch}`,
        count: 100,
        sort: 'timestamp',
        sort_dir: 'desc',
      });
      for (const match of (res.messages?.matches ?? [])) {
        if (!match.user || !missing.includes(match.user as string)) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const prof = (match as any).user_profile;
        const name = prof?.display_name || prof?.real_name || match.username as string | undefined;
        if (name) nameMap.set(match.user as string, name as string);
      }
    } catch { /* channel search failed — skip */ }
  }
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

    const ch = match.channel as { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean } | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channelName = (ch?.name ?? '') as string;
    if (!channelName || /^[A-Z][A-Z0-9]{8,}$/.test(channelName)) {
      if (ch?.is_im) channelName = 'Direct Message';
      else if (ch?.is_mpim) channelName = 'Group DM';
      else if (ch?.is_private) channelName = 'Private Channel';
      else channelName = 'unknown';
    }

    results.push({
      channelId: ch?.id ?? '',
      channelName,
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

// Returns a Slack mrkdwn channel reference that actually renders.
// <#C..|name> renders as a clickable #channel; DM/MPIM IDs (D..) do not —
// for those, return plain text so nothing raw leaks into the message.
function chanRef(channelId: string, channelName: string): string {
  return /^[CG][A-Z0-9]+$/.test(channelId)
    ? `<#${channelId}|${channelName}>`
    : channelName;
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
            `*${i + 1}. ${chanRef(m.channelId, m.channelName)} — ${title}*`,
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
      return `:large_green_circle: *${unattended.length + i + 1}.* _${m.userName}_ in ${chanRef(m.channelId, m.channelName)} → attended by ${responders}${ticketSuffix}  ·  <${m.permalink}|view>`;
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
  // Always list every member. Resolved names show as @name; unresolved fall
  // back to @member-N so no IDs leak and the count is always accurate.
  lines.push(
    l1MemberIds.map((id, i) => `@${userNames.get(id) ?? `member-${i + 1}`}`).join('   ')
  );
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

// Sequential canvas section lookup — one criteria at a time to stay inside
// Slack's canvas API rate limits (Tier-2: ~20 req/min).
async function lookupSectionIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  canvasId: string,
  criteria: Record<string, unknown>
): Promise<string[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await api.sections.lookup({ canvas_id: canvasId, criteria });
    return (res.sections ?? []).map((s: { id?: string }) => s.id).filter(Boolean) as string[];
  } catch {
    return [];
  }
}

async function refreshCanvas(
  client: WebClient,
  canvasId: string,
  markdown: string,
  memberIds: string[]
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (client as any).canvases;

  // ── Step 1: try files.info to get ALL section IDs in one shot ─────────────
  // canvases:read may cover this; fall back to lookup approach if it doesn't.
  let seedIds: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fi: any = await client.files.info({ file: canvasId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks: any[] = fi?.file?.blocks ?? fi?.content_blocks ?? [];
    seedIds = blocks.map(b => b.block_id ?? b.id).filter(Boolean) as string[];
    console.log(`  files.info: found ${seedIds.length} block(s)`);
  } catch (e: unknown) {
    console.log(`  files.info unavailable (${(e as Error).message ?? e}) — using section lookup`);
  }

  // ── Step 2: sequential lookups across all known types and text sweeps ──────
  // All calls run one at a time — parallel calls hit Slack's rate limit hard.
  const typeChunks = [
    ['any_header', 'bullet_list', 'ordered_list'],
    ['divider', 'table', 'todo'],
    ['quote', 'code_block', 'media'],
    ['rich_text', 'paragraph', 'people'],
    ['image', 'callout', 'embed'],
    ['heading1', 'heading2', 'heading3'],
  ];
  const textCriteria = [
    'the', 'in', 'is',               // broad English — finds any readable text section
    ...memberIds,                     // catches people-card sections storing raw user IDs
    'Tracker', 'Unattended', 'Attended', 'l1-support', 'local time', 'scanned',
  ];

  const everDeleted = new Set<string>(seedIds); // skip IDs already queued from files.info

  // Seed deletes from files.info
  for (const id of seedIds) {
    try {
      await api.edit({ canvas_id: canvasId, changes: [{ operation: 'delete', section_id: id }] });
    } catch { /* already gone */ }
  }

  // Lookup-based passes — stop when no new IDs appear that we haven't tried yet
  for (let pass = 0; pass < 8; pass++) {
    const found = new Set<string>();

    for (const types of typeChunks) {
      for (const id of await lookupSectionIds(api, canvasId, { section_types: types })) found.add(id);
    }
    for (const text of textCriteria) {
      for (const id of await lookupSectionIds(api, canvasId, { contains_text: text })) found.add(id);
    }

    const newIds = [...found].filter(id => !everDeleted.has(id));
    const stillPresent = [...found].filter(id => everDeleted.has(id));

    console.log(`  Pass ${pass + 1}: found ${found.size} section(s) total, ${newIds.length} new, ${stillPresent.length} already-deleted-but-still-indexed`);

    if (newIds.length === 0) {
      console.log(`  No new sections — clearing complete (${stillPresent.length} may be unfindable by API)`);
      break;
    }

    for (const id of newIds) {
      everDeleted.add(id);
      try {
        await api.edit({ canvas_id: canvasId, changes: [{ operation: 'delete', section_id: id }] });
      } catch { /* already gone */ }
    }
  }

  // ── Step 3: insert fresh content ──────────────────────────────────────────
  await api.edit({
    canvas_id: canvasId,
    changes: [{ operation: 'insert_at_start', document_content: { type: 'markdown', markdown } }],
  });
  console.log('  Canvas rebuilt');
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

      // Supplemental: search recent messages in channels where @l1-support was
      // mentioned — L1 members reply there, so their profiles surface for free.
      const uniqueChannels = [...new Set(mentions.map(m => m.channelName).filter(n => n && n !== 'unknown' && n !== 'Direct Message' && n !== 'Group DM' && n !== 'Private Channel'))];
      await enrichNameCacheFromChannels(client, allUserIds, uniqueChannels, userNames);
      console.log(`[${istStr}] Names resolved: ${[...userNames.keys()].length}/${allUserIds.length}`);

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
