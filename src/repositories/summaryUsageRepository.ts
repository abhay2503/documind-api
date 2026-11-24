import { execute, queryOne, type Queryable } from '../database/pool';

/**
 * Atomically consumes one summary from the user's quota for `usageDate` (a 'YYYY-MM-DD' UTC day).
 * Returns the new count, or undefined when the user is already at `dailyLimit`.
 *
 * Race-free by construction, with no SELECT-then-INSERT:
 * - The first request of the day inserts the row with count 1. If two "first" requests race, the
 *   unique (user_id, usage_date) constraint turns the loser into the ON CONFLICT branch.
 * - ON CONFLICT DO UPDATE takes a row lock. A concurrent request blocks on it, then re-evaluates the
 *   `WHERE summary_count < limit` guard against the committed count. With 4/5 used, exactly one of two
 *   concurrent requests reaches 5; the other updates no row and gets undefined back.
 * Run it inside the transaction that inserts the job, so a failed insert rolls the increment back.
 */
export async function incrementDailyUsage(
  db: Queryable,
  userId: string,
  usageDate: string,
  dailyLimit: number,
): Promise<number | undefined> {
  const row = await queryOne<{ summary_count: number }>(
    db,
    `INSERT INTO user_summary_usage (user_id, usage_date, summary_count)
     VALUES ($1, $2::date, 1)
     ON CONFLICT (user_id, usage_date) DO UPDATE
       SET summary_count = user_summary_usage.summary_count + 1
       WHERE user_summary_usage.summary_count < $3
     RETURNING summary_count`,
    [userId, usageDate, dailyLimit],
  );
  return row?.summary_count;
}

/** Current count for the day (0 if the user has not created a summary yet). Read-only. */
export async function getDailyUsage(db: Queryable, userId: string, usageDate: string): Promise<number> {
  const row = await queryOne<{ summary_count: number }>(
    db,
    'SELECT summary_count FROM user_summary_usage WHERE user_id = $1 AND usage_date = $2::date',
    [userId, usageDate],
  );
  return row?.summary_count ?? 0;
}

/**
 * Gives back one summary when an accepted job could not be queued at all (SQS publish failed and the
 * API answered 503). Never goes below zero. A job that fails later in the AI worker is NOT refunded.
 */
export async function releaseDailyUsage(db: Queryable, userId: string, usageDate: string): Promise<void> {
  await execute(
    db,
    `UPDATE user_summary_usage SET summary_count = summary_count - 1
     WHERE user_id = $1 AND usage_date = $2::date AND summary_count > 0`,
    [userId, usageDate],
  );
}
