import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DateTime } from 'luxon';
import {
  SKIP_REASON,
  createList,
  createTask,
  startHarness,
  type Harness,
  type SeededList,
  type TestUser,
} from './helpers/harness.ts';

const SCHEDULE = {
  cadence: 'daily' as const,
  cadenceIntervalDays: 3,
  weekStart: 1 as const,
  timezone: 'UTC',
  resetHour: 4,
};

/**
 * The reset mechanism, end to end.
 *
 * Nothing runs on a schedule. A tick is stored against the key of the period it
 * belongs to, and "is this done?" is a join on the key of the period we're in
 * now. These tests are the ones that would catch that quietly ceasing to be true.
 */
describe('completions and resets', { skip: SKIP_REASON }, () => {
  let h: Harness;
  let periodAt: typeof import('../src/periods.ts').periodAt;
  let owner: TestUser;
  let flatmate: TestUser;
  let list: SeededList;
  let task: { id: string };

  before(async () => {
    h = await startHarness();
    ({ periodAt } = await import('../src/periods.ts'));
  });

  after(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.truncate();
    owner = await h.signIn('owner');
    flatmate = await h.signIn('flatmate');
    list = await createList(owner, { name: 'Home', ...SCHEDULE });
    await h.join(list.id, flatmate.id, 'editor');
    task = await createTask(owner, list.id);
  });

  const rows = async () =>
    (await h.sql.query<{ period_key: string; completed_by: string }>(
      'SELECT period_key, completed_by FROM task_completions ORDER BY period_key',
    )).rows;

  describe('the period key', () => {
    it('is the server’s, not the client’s', async () => {
      // A phone with a wrong clock, or a hostile one, must not be able to place
      // a tick in a period of its choosing.
      const response = await owner.post(`/api/tasks/${task.id}/complete`, {
        periodKey: 'd:1999-01-01',
        completedBy: flatmate.id,
        completedAt: '1999-01-01T00:00:00Z',
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.periodKey, periodAt(SCHEDULE).key);
      assert.deepEqual(await rows(), [{ period_key: periodAt(SCHEDULE).key, completed_by: owner.id }]);
    });

    it('is reported on the list and matches what a tick is stored under', async () => {
      const detail = await owner.get(`/api/lists/${list.id}`);
      assert.equal(detail.body.periodKey, periodAt(SCHEDULE).key);

      await owner.post(`/api/tasks/${task.id}/complete`);
      assert.equal((await rows())[0]?.period_key, detail.body.periodKey);
    });

    it('is `static` for a list that never resets', async () => {
      const forever = await createList(owner, { name: 'Packing', cadence: 'none' });
      const item = await createTask(owner, forever.id, 'Passport');

      const response = await owner.post(`/api/tasks/${item.id}/complete`);
      assert.equal(response.body.periodKey, 'static');
    });
  });

  describe('completing is idempotent', () => {
    it('leaves one row and the first person’s name when two people tick', async () => {
      const first = await owner.post(`/api/tasks/${task.id}/complete`);
      const second = await flatmate.post(`/api/tasks/${task.id}/complete`);

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(first.body.completion.by.id, owner.id);
      assert.equal(
        second.body.completion.by.id,
        owner.id,
        'the second tick must report who actually did it first, not the caller',
      );
      assert.equal(second.body.completion.at, first.body.completion.at);
      assert.equal((await rows()).length, 1);
    });

    it('survives an offline queue replaying the same tick', async () => {
      for (let i = 0; i < 5; i++) {
        assert.equal((await owner.post(`/api/tasks/${task.id}/complete`)).status, 200);
      }
      assert.equal((await rows()).length, 1);
    });

    it('survives two people tapping at the same moment', async () => {
      const [a, b] = await Promise.all([
        owner.post(`/api/tasks/${task.id}/complete`),
        flatmate.post(`/api/tasks/${task.id}/complete`),
      ]);

      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal((await rows()).length, 1);
      assert.equal(a.body.completion.by.id, b.body.completion.by.id);
    });

    it('unticking then reticking hands the credit to whoever ticked last', async () => {
      await owner.post(`/api/tasks/${task.id}/complete`);
      assert.equal((await owner.del(`/api/tasks/${task.id}/complete`)).status, 204);
      assert.deepEqual(await rows(), []);

      const retick = await flatmate.post(`/api/tasks/${task.id}/complete`);
      assert.equal(retick.body.completion.by.id, flatmate.id);
      assert.equal((await rows()).length, 1);
    });

    it('unticking something that was never ticked is not an error', async () => {
      assert.equal((await owner.del(`/api/tasks/${task.id}/complete`)).status, 204);
    });
  });

  describe('rolling into a new period', () => {
    const yesterday = () => periodAt(SCHEDULE, DateTime.utc().minus({ days: 1 })).key;

    it('leaves yesterday’s tick behind and today outstanding', async () => {
      await h.sql.query(
        'INSERT INTO task_completions (task_id, period_key, completed_by) VALUES ($1, $2, $3)',
        [task.id, yesterday(), owner.id],
      );

      const detail = await owner.get(`/api/lists/${list.id}`);
      assert.equal(detail.body.tasks[0].completion, null, 'a new period means every task is outstanding');
      assert.equal(detail.body.doneCount, 0);

      const index = await owner.get('/api/lists');
      assert.equal(index.body[0].doneCount, 0);
    });

    it('does not delete the old row — the history is what the stats are made of', async () => {
      await h.sql.query(
        'INSERT INTO task_completions (task_id, period_key, completed_by) VALUES ($1, $2, $3)',
        [task.id, yesterday(), owner.id],
      );
      await owner.get(`/api/lists/${list.id}`);
      await owner.post(`/api/tasks/${task.id}/complete`);

      assert.deepEqual(
        (await rows()).map((row) => row.period_key),
        [periodAt(SCHEDULE).key, yesterday()].sort(),
      );
    });

    it('lets the same task be ticked again once the key changes', async () => {
      await h.sql.query(
        'INSERT INTO task_completions (task_id, period_key, completed_by) VALUES ($1, $2, $3)',
        [task.id, yesterday(), owner.id],
      );

      const today = await owner.post(`/api/tasks/${task.id}/complete`);
      assert.equal(today.status, 200, 'yesterday’s row must not block today’s tick');
      assert.equal(today.body.periodKey, periodAt(SCHEDULE).key);
    });
  });

  describe('deleting a task', () => {
    it('is a soft delete that keeps its completions', async () => {
      await owner.post(`/api/tasks/${task.id}/complete`);
      assert.equal((await owner.del(`/api/tasks/${task.id}`)).status, 204);

      const detail = await owner.get(`/api/lists/${list.id}`);
      assert.deepEqual(detail.body.tasks, [], 'the task should be gone from the list');

      const { rows: kept } = await h.sql.query(
        'SELECT archived_at IS NOT NULL AS archived FROM tasks WHERE id = $1',
        [task.id],
      );
      assert.equal(kept[0]?.archived, true, 'the task row itself must survive');
      assert.equal((await rows()).length, 1, 'a hard delete here would rewrite history');
    });

    it('stops it being ticked afterwards', async () => {
      await owner.del(`/api/tasks/${task.id}`);
      assert.equal((await owner.post(`/api/tasks/${task.id}/complete`)).status, 404);
    });
  });

  describe('stats', () => {
    it('count the current period’s ticks against the person who made them', async () => {
      await flatmate.post(`/api/tasks/${task.id}/complete`);

      const response = await owner.get(`/api/lists/${list.id}/stats?window=7`);
      assert.equal(response.status, 200);
      assert.equal(response.body.done, 1);

      const mine = response.body.people.find((person: { id: string }) => person.id === flatmate.id);
      assert.equal(mine.count, 1);
      assert.equal(
        response.body.people.find((person: { id: string }) => person.id === owner.id).count,
        0,
      );
    });

    it('ignore periods outside the window', async () => {
      await h.sql.query(
        'INSERT INTO task_completions (task_id, period_key, completed_by) VALUES ($1, $2, $3)',
        [task.id, periodAt(SCHEDULE, DateTime.utc().minus({ days: 400 })).key, owner.id],
      );

      const response = await owner.get(`/api/lists/${list.id}/stats?window=7`);
      assert.equal(response.body.done, 0);
    });
  });
});
