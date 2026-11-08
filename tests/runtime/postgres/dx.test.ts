import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  createDatabase,
  int,
  text,
  bigint,
  jsonb,
  sqlState,
  IsolationLevel,
} from "../../../packages/runtime/src";
import { postgres, testDatabase } from "../../support/postgres";

const model = schema({
  events: {
    id: int.auto,
    label: text,
    amount: bigint,
    payload: jsonb<{ n: number }>(),
  },
  accounts: { id: int.auto, balance: bigint },
});

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("streaming and retries on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof model>>>;
  let database: typeof isolated.database;

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: model,
      prefix: "symmetria_dx",
      max: 1,
    });
    database = isolated.database;
    await database.events.insert(
      Array.from({ length: 2500 }, (_, index) => ({
        label: `event ${index}`,
        amount: BigInt(index) * 10n,
        payload: { n: index },
      })),
    );
    await database.accounts.insert({ balance: 100n });
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("stream() yields every row in order with decoded values", async () => {
    let count = 0;
    let previous = -1;

    for await (const row of database
      .events(
        (event) => ({
          id: event.id,
          amount: event.amount,
          n: event.payload.path("n"),
        }),
        { orderBy: (event) => event.id.ascending },
      )
      .stream({ size: 1000 })) {
      expect(row.id).toBeGreaterThan(previous);
      expect(typeof row.amount).toBe("bigint");
      expect(row.amount).toBe(BigInt(row.n!) * 10n);
      previous = row.id;
      count += 1;
    }

    expect(count).toBe(2500);
  });

  test("an early break frees the only connection", async () => {
    for await (const row of database
      .events((event) => ({ id: event.id }))
      .stream({ size: 10 })) {
      if (row.id) {
        break;
      }
    }

    expect(
      await database.events((event) => ({ id: event.id }), { limit: 1 }),
    ).toHaveLength(1);
  });

  test("a stream inside a transaction sees its writes and leaves the transaction usable", async () => {
    const seen = await database
      .$transaction(async (tx) => {
        await tx.events.insert({
          label: "inside",
          amount: 1n,
          payload: { n: -1 },
        });
        const labels: string[] = [];

        for await (const row of tx
          .events((event) => ({ label: event.label }), {
            where: (event) => event.label.is("inside"),
          })
          .stream({ size: 5 })) {
          labels.push(row.label);
          await tx.events.insert({
            label: "during",
            amount: 2n,
            payload: { n: -2 },
          });
        }

        const during = await tx.events((event) => ({ id: event.id }), {
          where: (event) => event.label.is("during"),
        });
        throw Object.assign(new Error("discard"), {
          result: { labels, during: during.length },
        });
      })
      .catch((error: { result: unknown }) => error.result);

    expect(seen).toEqual({ labels: ["inside"], during: 1 });
  });

  test("retries re-run a transaction after a serialization failure", async () => {
    const observerConnection = new URL(databaseUrl!);
    observerConnection.searchParams.set(
      "options",
      `-c search_path=${isolated.namespace}`,
    );
    const observerDriver = postgres({
      url: observerConnection.toString(),
      max: 1,
    });
    const observer = createDatabase({ schema: model, driver: observerDriver });

    try {
      let attempts = 0;
      const work = async (tx: typeof database) => {
        attempts += 1;
        const account = await tx.accounts
          .byId(1)((row) => ({ balance: row.balance }))
          .one();

        if (attempts === 1) {
          // A concurrent writer changes the row between our read and write.
          await observer.accounts
            .byId(1)
            .update({ balance: account.balance + 1000n })
            .execute();
        }

        await tx.accounts
          .byId(1)
          .update({ balance: account.balance + 1n })
          .execute();
      };

      const failure = await database
        .$transaction((tx) => work(tx as unknown as typeof database), {
          isolationLevel: IsolationLevel.RepeatableRead,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(sqlState(failure)).toBe("40001");
      expect(attempts).toBe(1);

      attempts = 0;
      await database.$transaction(
        (tx) => work(tx as unknown as typeof database),
        {
          isolationLevel: IsolationLevel.RepeatableRead,
          retries: 2,
          retryDelayMs: 0,
        },
      );
      expect(attempts).toBe(2);
      expect(
        await database.accounts
          .byId(1)((row) => ({ balance: row.balance }))
          .one(),
      ).toEqual({ balance: 2101n });
    } finally {
      await observerDriver.close();
    }
  });
});
