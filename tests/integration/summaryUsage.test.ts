/**
 * Opt-in PostgreSQL check of the daily summary quota: the atomic check-and-increment and its behavior
 * under concurrency. Prerequisites: npm run migrate. Run with: npm run test:postgres
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, setConfigForTests } from '../../src/config';
import { closePool, execute, getPool, withTransaction } from '../../src/database/pool';
import { getDailyUsage, incrementDailyUsage, releaseDailyUsage } from '../../src/repositories/summaryUsageRepository';

const enabled = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!enabled)('user_summary_usage (PostgreSQL)', () => {
  if (enabled) {
    process.loadEnvFile('.env');
    setConfigForTests(loadConfig({ ...process.env, NODE_ENV: 'development' }));
  }
  const tag = Math.random().toString(16).slice(2, 10);
  const userA = `quota-test-a-${tag}`;
  const userB = `quota-test-b-${tag}`;
  const today = '2026-11-23';
  const tomorrow = '2026-11-24';

  const setUsage = (userId: string, date: string, count: number) =>
    execute(
      getPool(),
      `INSERT INTO user_summary_usage (user_id, usage_date, summary_count) VALUES ($1, $2::date, $3)
       ON CONFLICT (user_id, usage_date) DO UPDATE SET summary_count = EXCLUDED.summary_count`,
      [userId, date, count],
    );

  beforeEach(async () => {
    await execute(getPool(), 'DELETE FROM user_summary_usage WHERE user_id IN ($1, $2)', [userA, userB]);
  });

  afterAll(async () => {
    await execute(getPool(), 'DELETE FROM user_summary_usage WHERE user_id IN ($1, $2)', [userA, userB]);
    await closePool();
  });

  it('normal user: 0/5 → 1, 4/5 → 5, then 5/5 is rejected without changing the count', async () => {
    expect(await incrementDailyUsage(getPool(), userA, today, 5)).toBe(1);
    await setUsage(userA, today, 4);
    expect(await incrementDailyUsage(getPool(), userA, today, 5)).toBe(5);
    expect(await incrementDailyUsage(getPool(), userA, today, 5)).toBeUndefined();
    expect(await getDailyUsage(getPool(), userA, today)).toBe(5);
  });

  it('admin: 49/50 → 50, then 50/50 is rejected', async () => {
    await setUsage(userA, today, 49);
    expect(await incrementDailyUsage(getPool(), userA, today, 50)).toBe(50);
    expect(await incrementDailyUsage(getPool(), userA, today, 50)).toBeUndefined();
    expect(await getDailyUsage(getPool(), userA, today)).toBe(50);
  });

  it('a new UTC day starts at 0', async () => {
    await setUsage(userA, today, 5);
    expect(await getDailyUsage(getPool(), userA, tomorrow)).toBe(0);
    expect(await incrementDailyUsage(getPool(), userA, tomorrow, 5)).toBe(1);
    expect(await getDailyUsage(getPool(), userA, today)).toBe(5);
  });

  it("one user's usage never touches another user's quota", async () => {
    await setUsage(userA, today, 5);
    expect(await incrementDailyUsage(getPool(), userA, today, 5)).toBeUndefined();
    expect(await incrementDailyUsage(getPool(), userB, today, 5)).toBe(1);
    expect(await getDailyUsage(getPool(), userA, today)).toBe(5);
    expect(await getDailyUsage(getPool(), userB, today)).toBe(1);
  });

  it('two concurrent requests at 4/5: exactly one gets the last summary', async () => {
    await setUsage(userA, today, 4);
    let release!: () => void;
    const holdOpen = new Promise<void>((resolve) => (release = resolve));
    let firstIncremented!: () => void;
    const firstDone = new Promise<void>((resolve) => (firstIncremented = resolve));

    // Request 1 increments and keeps its transaction (and the row lock) open.
    const first = withTransaction(async (conn) => {
      const count = await incrementDailyUsage(conn, userA, today, 5);
      firstIncremented();
      await holdOpen;
      return count;
    });
    await firstDone;
    // Request 2 runs while request 1 is still uncommitted: it must block on the row lock, then re-check.
    const second = withTransaction((conn) => incrementDailyUsage(conn, userA, today, 5));
    await new Promise((r) => setTimeout(r, 150));
    release();

    expect(await first).toBe(5);
    expect(await second).toBeUndefined();
    expect(await getDailyUsage(getPool(), userA, today)).toBe(5);
  });

  it('two concurrent first-of-day requests both succeed (no duplicate-row error)', async () => {
    const results = await Promise.all([
      withTransaction((conn) => incrementDailyUsage(conn, userA, today, 5)),
      withTransaction((conn) => incrementDailyUsage(conn, userA, today, 5)),
    ]);
    expect(results.sort()).toEqual([1, 2]);
  });

  it('a burst of 12 concurrent requests from 0/5 allows exactly 5', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => withTransaction((conn) => incrementDailyUsage(conn, userA, today, 5))),
    );
    expect(results.filter((r) => r !== undefined).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(results.filter((r) => r === undefined)).toHaveLength(7);
    expect(await getDailyUsage(getPool(), userA, today)).toBe(5);
  });

  it('an increment rolled back with its transaction is not counted', async () => {
    await expect(
      withTransaction(async (conn) => {
        await incrementDailyUsage(conn, userA, today, 5);
        throw new Error('job insert failed');
      }),
    ).rejects.toThrow('job insert failed');
    expect(await getDailyUsage(getPool(), userA, today)).toBe(0);
  });

  it('release gives back one summary and never goes below zero', async () => {
    await setUsage(userA, today, 1);
    await releaseDailyUsage(getPool(), userA, today);
    await releaseDailyUsage(getPool(), userA, today);
    expect(await getDailyUsage(getPool(), userA, today)).toBe(0);
  });
});
