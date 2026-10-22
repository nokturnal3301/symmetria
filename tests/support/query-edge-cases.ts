import { expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bigint,
  jsonb,
  timestamptz,
  customType,
  createDatabase,
  count,
  coalesce,
  lag,
  lead,
  prepare,
} from "../../packages/runtime/src";
import { sqlite } from "../../packages/runtime/src/driver";
import { testDatabase } from "../../packages/kit/src/testing";

const handle = customType<{ label: string }>("text", {
  encode: (value) => `encoded:${value.label}`,
  decode: (value) => ({ label: String(value).slice(8) }),
});
const model = schema({
  users: {
    id: int,
    name: text,
    visits: bigint,
    created: timestamptz,
    handle,
    metadata: jsonb<string>(),
    numbers: bigint.array,
    labels: jsonb<string>().array,
  },
  posts: ({ users }) => ({
    id: int,
    author: users,
    editor: users.nullable.inverse("edited"),
    title: text,
  }),
});
const created = new Date("2026-01-01T00:00:00Z");
const fallback = {
  visits: 9007199254740995n,
  created,
  handle: { label: "fallback" },
  metadata: "123",
  numbers: [9007199254740997n],
  labels: ["123", "true", "null", "hello"],
};

export const queryEdgeCaseTests = (dialect: "postgres" | "sqlite"): void => {
  const fixture = async () => {
    const postgresFixture =
      dialect === "postgres"
        ? await testDatabase({
            url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
            schema: model,
            max: 4,
          })
        : undefined;
    const local = postgresFixture ? undefined : sqlite();
    local?.createTables(model);
    const driver = postgresFixture?.driver ?? local!;
    const database =
      postgresFixture?.database ?? createDatabase({ schema: model, driver });
    await database.users.insert(
      [1, 2, 3].map((id) => ({
        ...fallback,
        id,
        name: `user-${id}`,
        visits: BigInt(id),
      })),
    );
    await database.posts.insert([
      { id: 1, authorId: 1, editorId: 2, title: "a" },
      { id: 2, authorId: 1, editorId: null, title: "b" },
      { id: 3, authorId: 2, editorId: null, title: "c" },
    ]);

    return {
      database,
      close: postgresFixture ? postgresFixture.close : () => database.$close(),
    };
  };

  test("equivalent correlated subqueries group with stable parameter identities", async () => {
    const { database, close } = await fixture();

    try {
      const query = prepare({ minimum: int }, (parameters) =>
        database.users((users) => ({
          total: users
            .posts((posts) => ({ $where: posts.id.above(parameters.minimum) }))
            .count(),
          users: count(),
          $groupBy: [
            users
              .posts((posts) => ({
                $where: posts.id.above(parameters.minimum),
              }))
              .count(),
          ],
          $having: users
            .posts((posts) => ({ $where: posts.id.above(parameters.minimum) }))
            .count()
            .atLeast(0),
          $orderBy: users
            .posts((posts) => ({ $where: posts.id.above(parameters.minimum) }))
            .count().ascending,
        })),
      );
      expect(await query.execute({ minimum: 1 })).toEqual([
        { total: 0, users: 1 },
        { total: 1, users: 2 },
      ]);
      expect(await query.execute({ minimum: 3 })).toEqual([
        { total: 0, users: 3 },
      ]);
    } finally {
      await close();
    }
  });

  test("DISTINCT matches repeated subqueries without merging different correlations or filters", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.users((users) => ({
        authored: users
          .posts((posts) => ({ $where: posts.id.above(1) }))
          .count(),
        edited: users
          .edited((edited) => ({ $where: edited.id.above(0) }))
          .count(),
        all: users.posts((posts) => ({ $where: posts.id.above(0) })).count(),
        $distinct: true,
        $orderBy: [
          users.posts((posts) => ({ $where: posts.id.above(1) })).count()
            .ascending,
          users.edited((edited) => ({ $where: edited.id.above(0) })).count()
            .ascending,
        ],
      }));
      expect(await query).toEqual([
        { authored: 0, edited: 0, all: 0 },
        { authored: 1, edited: 0, all: 2 },
        { authored: 1, edited: 1, all: 1 },
      ]);
    } finally {
      await close();
    }
  });

  test("composite coalesce fallbacks encode bigints, dates, custom values and JSON arrays", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.posts((posts) => ({
        id: posts.id,
        editor: coalesce(
          posts.editor((editor) => ({
            visits: editor.visits,
            created: editor.created,
            handle: editor.handle,
            metadata: editor.metadata,
            numbers: editor.numbers,
            labels: editor.labels,
          })),
          fallback,
        ),
        $where: posts.id.atMost(2),
        $orderBy: posts.id.ascending,
      }));
      const expected = [
        { id: 1, editor: { ...fallback, visits: 2n } },
        { id: 2, editor: fallback },
      ];
      expect(await query).toEqual(expected);
      expect(
        await query.cte("editors")((editors) => ({
          id: editors.id,
          editor: editors.editor,
          $orderBy: editors.id.ascending,
        })),
      ).toEqual(expected);
      expect(
        await query.as("editors")((editors) => ({
          nested: { editor: editors.editor },
          $orderBy: editors.id.ascending,
        })),
      ).toEqual(expected.map(({ editor }) => ({ nested: { editor } })));
    } finally {
      await close();
    }
  });

  test("window fallbacks encode recursively nested objects and relation collections", async () => {
    const { database, close } = await fixture();

    try {
      const payloads = database
        .users((users) => ({
          id: users.id,
          payload: {
            nested: {
              visits: users.visits,
              created: users.created,
              handle: users.handle,
              metadata: users.metadata,
              numbers: users.numbers,
              labels: users.labels,
            },
          },
          posts: users.posts((posts) => ({
            id: posts.id,
            $orderBy: posts.id.ascending,
          })),
        }))
        .cte("payloads");
      const query = payloads((payloads) => ({
        previous: lag(payloads.payload, 1, { nested: fallback }).over({
          orderBy: payloads.id.ascending,
        }),
        nextPosts: lead(payloads.posts, 1, [{ id: 99 }]).over({
          orderBy: payloads.id.ascending,
        }),
        $orderBy: payloads.id.ascending,
      }));
      expect(await query).toEqual([
        { previous: { nested: fallback }, nextPosts: [{ id: 3 }] },
        {
          previous: { nested: { ...fallback, visits: 1n } },
          nextPosts: [],
        },
        {
          previous: { nested: { ...fallback, visits: 2n } },
          nextPosts: [{ id: 99 }],
        },
      ]);
    } finally {
      await close();
    }
  });

  test("concurrent transactions retain increments while nested savepoints roll back", async () => {
    const { database, close } = await fixture();

    try {
      await Promise.all(
        Array.from({ length: 30 }, () =>
          database.$transaction(async (transaction) => {
            await transaction.users
              .update((users) => ({ visits: users.visits.plus(1n) }))
              .where((users) => users.id.is(1));
            await expect(
              transaction.$transaction(async (nested) => {
                await nested.users
                  .update((users) => ({ visits: users.visits.plus(100n) }))
                  .where((users) => users.id.is(1));
                throw new Error("rollback savepoint");
              }),
            ).rejects.toThrow("rollback savepoint");
          }),
        ),
      );
      expect(
        await database.users((users) => ({
          visits: users.visits,
          $where: users.id.is(1),
        })),
      ).toEqual([{ visits: 31n }]);
    } finally {
      await close();
    }
  });

  test("CTE and derived roots preserve relation queries on joined schema tables", async () => {
    const { database, close } = await fixture();

    try {
      const eligible = database
        .posts((posts) => ({ authorId: posts.authorId, $distinct: true }))
        .cte("eligible");
      const query = eligible.as("eligibleAuthors")(
        (eligibleAuthors, { innerJoin }) => {
          const owner = innerJoin(database.users.as("owner"), (owner) =>
            eligibleAuthors.authorId.is(owner.id),
          );

          return {
            id: owner.id,
            posts: owner.posts((posts) => ({
              title: posts.title,
              $orderBy: posts.id.ascending,
            })),
            $orderBy: owner.id.ascending,
          };
        },
      );
      expect(await query).toEqual([
        { id: 1, posts: [{ title: "a" }, { title: "b" }] },
        { id: 2, posts: [{ title: "c" }] },
      ]);
      expect(
        await database
          .posts((posts) => ({ authorId: posts.authorId, $distinct: true }))
          .as("users")((users, { innerJoin }) => {
          const owner = innerJoin(database.users.as("owner"), (owner) =>
            users.authorId.is(owner.id),
          );
          const posts = innerJoin(owner.posts);

          return { title: posts.title, $orderBy: posts.id.ascending };
        }),
      ).toEqual([{ title: "a" }, { title: "b" }, { title: "c" }]);
    } finally {
      await close();
    }
  });
};
