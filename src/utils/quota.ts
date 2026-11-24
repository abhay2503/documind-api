/** Daily summary jobs a normal authenticated user may create. */
export const USER_DAILY_SUMMARY_LIMIT = 5;
/** Daily summary jobs a member of the Cognito `admin` group may create. */
export const ADMIN_DAILY_SUMMARY_LIMIT = 50;

export function dailySummaryLimit(isAdmin: boolean): number {
  return isAdmin ? ADMIN_DAILY_SUMMARY_LIMIT : USER_DAILY_SUMMARY_LIMIT;
}

/**
 * The quota day is the UTC calendar day on the server ('YYYY-MM-DD'), so every user's quota resets at
 * 00:00 UTC (05:30 IST). This is a deliberate first-version choice: it is consistent everywhere and
 * cannot be influenced by the browser's timezone. Per-user local days would need a stored user timezone.
 */
export function utcUsageDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
