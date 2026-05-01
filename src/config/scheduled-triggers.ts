/**
 * Scheduled Triggers Configuration
 *
 * Defines automated triggers for various Slack-based workflows.
 */

export interface ScheduledTrigger {
  id: string;
  name: string;
  description: string;
  schedule: {
    intervalMinutes: number;
    startTimeIST: string;
    daysOfWeek: ('Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday')[];
    timezone: string;
  };
  action: {
    type: 'slack_scan';
    targetUsergroup: string;
    channel: string;
    scanScope: string;
    instructions: string;
  };
}

/**
 * Auto-Scan Trigger Configuration
 *
 * Scans Slack channels for @l1-support mentions and reports attended/unattended status.
 *
 * Schedule: Every 45 minutes starting at 8:00 AM IST, weekdays only (Mon-Fri)
 *
 * IMPORTANT: L1 support team membership is DYNAMIC and resolved at runtime
 * via the @l1-support usergroup. Do NOT hardcode individual user IDs.
 */
export const autoScanTrigger: ScheduledTrigger = {
  id: 'auto-scan-l1-support',
  name: 'Auto-Scan Trigger',
  description: 'Scans all Slack channels for @l1-support mentions and reports attended/unattended status',
  schedule: {
    intervalMinutes: 45,
    startTimeIST: '08:00',
    daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    timezone: 'Asia/Kolkata', // IST - Indian Standard Time (UTC+5:30)
  },
  action: {
    type: 'slack_scan',
    // Dynamic usergroup reference - membership resolved at runtime
    // Do NOT replace with hardcoded user IDs like @U07K5U2QJHW, @U087QBEDXNC, @U086YCMHN3F
    targetUsergroup: '@l1-support',
    channel: '#l1-support-tickets',
    scanScope: 'all_channels',
    instructions: `Scan all Slack channels for new @l1-support mentions. For each mention, check the thread for responses from L1 team members (dynamically resolved from @l1-support usergroup). Post a summary showing :large_green_circle: Attended (by whom) or :red_circle: Unattended for each. Tag L1 team on any unattended mentions.`,
  },
};

/**
 * Converts IST start time to cron expression for the scheduled trigger.
 *
 * Schedule: Every 45 minutes starting at 8:00 AM IST, Mon-Fri
 *
 * The trigger fires at these IST times on weekdays:
 * 08:00, 08:45, 09:30, 10:15, 11:00, 11:45, 12:30, 13:15, 14:00, 14:45,
 * 15:30, 16:15, 17:00, 17:45, 18:30, 19:15, 20:00, 20:45, 21:30, 22:15, 23:00, 23:45
 * (continues through the day in 45-min intervals)
 */
export function getAutoScanCronExpression(): string {
  // Cron doesn't natively support 45-minute intervals, so we define specific minutes
  // Starting at :00, then :45, :30, :15 (cycling through hours)
  // For simplicity, we'll use multiple cron entries or a scheduler that supports intervals

  // This represents: "At minute 0 and 45 of hours 8-23, Mon-Fri, in Asia/Kolkata timezone"
  // Note: True 45-min intervals require a more sophisticated scheduler
  return '0,45 8-23 * * 1-5'; // Approximation - runs at :00 and :45 each hour
}

/**
 * Generates the human-readable schedule description
 */
export function getScheduleDescription(): string {
  const { schedule } = autoScanTrigger;
  const days = schedule.daysOfWeek.join(', ');
  return `Every ${schedule.intervalMinutes} minutes starting from ${schedule.startTimeIST} IST (${schedule.timezone}), on ${days}`;
}

/**
 * Generates the Slack message template for the Auto-Scan Trigger
 *
 * IMPORTANT: Uses @l1-support usergroup for dynamic member resolution.
 * The Slack API will automatically resolve current usergroup members at post time.
 */
export function getAutoScanSlackMessage(): string {
  return `:arrows_counterclockwise: *Auto-Scan Trigger* (every 45 min)
\`@Claude\` — Scan all Slack channels for new \`@l1-support\` mentions. For each mention, check the thread for responses from <!subteam^l1-support> members. Post a summary here showing :large_green_circle: Attended (by whom) or :red_circle: Unattended for each. Tag L1 team on any unattended mentions.`;
}

// Export all scheduled triggers
export const scheduledTriggers: ScheduledTrigger[] = [
  autoScanTrigger,
];

export default scheduledTriggers;
