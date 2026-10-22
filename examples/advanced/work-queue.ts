import assert from "node:assert/strict";
import {
  schema,
  table,
  int,
  text,
  oneOf,
  jsonb,
  timestamptz,
  index,
  and,
  or,
  sql,
} from "symmetria";
import { testDatabase } from "symmetria-kit/testing";

const model = schema({
  jobs: table({
    id: int.auto,
    key: text.unique,
    state: oneOf("queued", "running", "done").default("queued"),
    payload: jsonb<{ destination: string; body: string }>(),
    attempts: int.default(0),
    availableAt: timestamptz.now,
    leaseUntil: timestamptz.nullable,
    leaseToken: text.nullable,
    worker: text.nullable,
  }).indexes((job) => ({
    ready: index(job.state, job.availableAt, job.id),
    expired: index(job.state, job.leaseUntil),
  })),
});
const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "Set DATABASE_URL to run the isolated PostgreSQL queue demo.",
  );
}

const isolated = await testDatabase({
  url,
  schema: model,
  prefix: "symmetria_queue",
  max: 4,
});
const database = isolated.database;

const claim = (worker: string, size: number) =>
  database.$transaction(async (transaction) => {
    // One database clock, independent of worker-machine clock skew.
    const now = sql<Date>`CURRENT_TIMESTAMP`;
    const candidates = await transaction.jobs((job) => ({
      id: job.id,
      $where: [
        job.availableAt.atMost(now),
        or(
          job.state.is.queued,
          and(job.state.is.running, job.leaseUntil.atMost(now)),
        ),
      ],
      $orderBy: [job.availableAt.ascending, job.id.ascending],
      $limit: size,
      $forUpdate: { skipLocked: true },
    }));

    if (!candidates.length) {
      return [];
    }

    const leaseToken = crypto.randomUUID();
    const rows = await transaction.jobs
      .update((job) => ({
        state: "running",
        worker,
        leaseToken,
        leaseUntil: sql<Date>`CURRENT_TIMESTAMP + interval '30 seconds'`,
        attempts: job.attempts.plus(1),
      }))
      .where((job) => job.id.in(candidates.map((candidate) => candidate.id)))
      .returning((job) => ({
        id: job.id,
        key: job.key,
        payload: job.payload,
        attempts: job.attempts,
      }));

    // The transaction commits before the caller performs slow external work.
    return rows.map((row) => ({ ...row, leaseToken }));
  });

type ClaimedJob = Awaited<ReturnType<typeof claim>>[number];

const acknowledge = async (claimed: ClaimedJob): Promise<boolean> => {
  const result = await database.jobs
    .update({ state: "done", leaseToken: null, leaseUntil: null })
    .where((job) =>
      and(
        job.id.is(claimed.id),
        job.state.is.running,
        job.leaseToken.is(claimed.leaseToken),
        job.leaseUntil.above(sql<Date>`CURRENT_TIMESTAMP`),
      ),
    );

  return result.affectedRows === 1;
};

const deliver = async (jobs: readonly ClaimedJob[]) => {
  for (const job of jobs) {
    // A real downstream service should deduplicate by this stable event key.
    console.log("deliver outside transaction", {
      idempotencyKey: job.key,
      ...job.payload,
    });
    assert.equal(await acknowledge(job), true);
  }
};

try {
  await database.jobs.insert(
    Array.from({ length: 6 }, (_, index) => ({
      key: `notification-${index}`,
      payload: {
        destination: `user-${index}@example.test`,
        body: `Notification ${index}`,
      },
    })),
  );

  const [abandoned] = await claim("crashed-worker", 1);
  assert.ok(abandoned);
  // Simulate a crashed worker's expired lease without waiting thirty seconds.
  await database.jobs
    .update({ leaseUntil: sql<Date>`CURRENT_TIMESTAMP - interval '1 second'` })
    .where((job) => job.id.is(abandoned.id));

  const [first, second] = await Promise.all([
    claim("worker-a", 2),
    claim("worker-b", 2),
  ]);
  const claimedIds = [...first, ...second].map((job) => job.id);
  assert.equal(claimedIds.length, 4);
  assert.equal(new Set(claimedIds).size, 4);
  assert.ok(claimedIds.includes(abandoned.id));
  assert.equal(await acknowledge(abandoned), false);
  await Promise.all([deliver(first), deliver(second)]);
  await deliver(await claim("worker-c", 2));

  const completed = await database.jobs((job) => ({
    id: job.id,
    state: job.state,
    attempts: job.attempts,
    $orderBy: job.id.ascending,
  }));
  assert.equal(completed.length, 6);
  assert.ok(completed.every((job) => job.state === "done"));
  assert.equal(completed.find((job) => job.id === abandoned.id)!.attempts, 2);
  console.log("work queue verified", completed);
} finally {
  await isolated.close();
}
