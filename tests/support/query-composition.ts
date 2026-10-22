import { expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bool,
  bigint,
  jsonb,
  junction,
  createDatabase,
  count,
  rowNumber,
  lag,
  lead,
  coalesce,
  prepare,
  sql,
} from "../../packages/runtime/src";
import { sqlite } from "../../packages/runtime/src/driver";
import { testDatabase } from "../../packages/kit/src/testing";

const model = schema({
  users: {
    id: int,
    tenantId: int,
    name: text,
    active: bool,
    metadata: jsonb<{ label: string }>(),
  },
  posts: ({ users }) => ({
    id: int,
    author: users.index,
    editor: users.nullable.inverse("edited"),
    title: text,
    views: bigint,
    metadata: jsonb<string>(),
  }),
  comments: ({ posts }) => ({ id: int, post: posts, body: text, score: int }),
  tags: { id: int, label: text },
  postTags: ({ posts, tags }) => junction({ post: posts, tag: tags }),
});

export const queryCompositionTests = (dialect: "postgres" | "sqlite"): void => {
  const fixture = async () => {
    const postgresFixture =
      dialect === "postgres"
        ? await testDatabase({
            url: process.env.SYMMETRIA_TEST_DATABASE_URL!,
            schema: model,
            max: 1,
          })
        : undefined;
    const local = postgresFixture ? undefined : sqlite();
    local?.createTables(model);
    const driver = postgresFixture?.driver ?? local!;
    const database =
      postgresFixture?.database ?? createDatabase({ schema: model, driver });

    await database.users.insert([
      {
        id: 1,
        tenantId: 1,
        name: "Ada",
        active: true,
        metadata: { label: "alpha" },
      },
      {
        id: 2,
        tenantId: 1,
        name: "Grace",
        active: false,
        metadata: { label: "beta" },
      },
      {
        id: 3,
        tenantId: 2,
        name: "Other tenant",
        active: true,
        metadata: { label: "other" },
      },
    ]);
    await database.posts.insert([
      {
        id: 1,
        authorId: 1,
        editorId: 2,
        title: "SQL",
        views: 9007199254740993n,
        metadata: "hello",
      },
      {
        id: 2,
        authorId: 1,
        editorId: null,
        title: "TS",
        views: 30n,
        metadata: "123",
      },
      {
        id: 3,
        authorId: 2,
        editorId: null,
        title: "Other",
        views: 20n,
        metadata: "true",
      },
      {
        id: 4,
        authorId: 3,
        editorId: null,
        title: "Private",
        views: 40n,
        metadata: "null",
      },
    ]);
    await database.comments.insert([
      { id: 1, postId: 1, body: "A", score: 3 },
      { id: 2, postId: 1, body: "B", score: 4 },
      { id: 3, postId: 2, body: "C", score: 5 },
    ]);
    await database.tags.insert([
      { id: 1, label: "sql" },
      { id: 2, label: "ts" },
    ]);
    await database.postTags.insert([
      { postId: 1, tagId: 1 },
      { postId: 1, tagId: 2 },
      { postId: 2, tagId: 2 },
    ]);

    return {
      database,
      driver,
      close: postgresFixture ? postgresFixture.close : () => database.$close(),
    };
  };

  test("three CTEs, window ranking, prepared filters, nested collections and junctions compose", async () => {
    const { database, close } = await fixture();

    try {
      const query = prepare({ tenant: int, top: int }, (parameters) => {
        const ranked = database
          .posts((posts) => ({
            id: posts.id,
            position: rowNumber().over({
              partitionBy: [posts.authorId],
              orderBy: [posts.views.descending, posts.id.ascending],
            }),
          }))
          .cte("ranked");
        const totals = database
          .posts((posts) => ({
            authorId: posts.authorId,
            total: count(),
            $groupBy: [posts.authorId],
          }))
          .cte("totals");
        const eligible = totals((totals) => ({
          authorId: totals.authorId,
          total: totals.total,
          $where: totals.total.above(0),
        })).cte("eligible");

        return database.users.as("owner")((owner, { innerJoin }) => {
          const eligibleRow = innerJoin(eligible, (eligibleRow) =>
            owner.id.is(eligibleRow.authorId),
          );

          return {
            id: owner.id,
            total: eligibleRow.total,
            owner: { name: owner.name, active: owner.active },
            posts: owner.posts((posts) => ({
              id: posts.id,
              views: posts.views,
              metadata: posts.metadata,
              editor: posts.editor((editor) => ({ name: editor.name })),
              comments: posts.comments((comments) => ({
                body: comments.body,
                post: comments.post((post) => ({ title: post.title })),
                $orderBy: comments.score.descending,
                $limit: 1,
              })),
              tags: posts.tags((tags) => ({
                label: tags.label,
                $orderBy: tags.id.ascending,
              })),
              $where: posts.id.in(
                ranked((ranked) => ({
                  id: ranked.id,
                  $where: ranked.position.atMost(parameters.top),
                })),
              ),
              $orderBy: posts.id.ascending,
            })),
            $where: owner.tenantId.is(parameters.tenant),
            $orderBy: owner.id.ascending,
          };
        });
      });
      expect(await query.execute({ tenant: 1, top: 1 })).toEqual([
        {
          id: 1,
          total: 2,
          owner: { name: "Ada", active: true },
          posts: [
            {
              id: 1,
              views: 9007199254740993n,
              metadata: "hello",
              editor: { name: "Grace" },
              comments: [{ body: "B", post: { title: "SQL" } }],
              tags: [{ label: "sql" }, { label: "ts" }],
            },
          ],
        },
        {
          id: 2,
          total: 1,
          owner: { name: "Grace", active: false },
          posts: [
            {
              id: 3,
              views: 20n,
              metadata: "true",
              editor: null,
              comments: [],
              tags: [],
            },
          ],
        },
      ]);
      expect(await query.execute({ tenant: 1, top: 0 })).toEqual([
        { id: 1, total: 2, owner: { name: "Ada", active: true }, posts: [] },
        { id: 2, total: 1, owner: { name: "Grace", active: false }, posts: [] },
      ]);
    } finally {
      await close();
    }
  });

  test("computed grouping, HAVING and DISTINCT reuse parameterized expressions through CTEs", async () => {
    const { database, close } = await fixture();

    try {
      const literal = database.users((users) => ({
        bucket: users.id.plus(1),
        total: count(),
        $groupBy: [users.id.plus(1)],
        $having: users.id.plus(1).above(2),
        $orderBy: users.id.plus(1).ascending,
      }));
      expect(await literal).toEqual([
        { bucket: 3, total: 1 },
        { bucket: 4, total: 1 },
      ]);
      const query = prepare({ increment: int, minimum: int }, (parameters) =>
        database
          .users((users) => ({
            bucket: users.id.plus(parameters.increment),
            total: count(),
            $groupBy: [users.id.plus(parameters.increment)],
            $having: users.id
              .plus(parameters.increment)
              .above(parameters.minimum),
          }))
          .cte("buckets")((buckets) => ({
          bucket: buckets.bucket,
          total: buckets.total,
          $orderBy: buckets.bucket.ascending,
        })),
      );
      expect(await query.execute({ increment: 1, minimum: 2 })).toEqual([
        { bucket: 3, total: 1 },
        { bucket: 4, total: 1 },
      ]);
      expect(await query.execute({ increment: 2, minimum: 2 })).toEqual([
        { bucket: 3, total: 1 },
        { bucket: 4, total: 1 },
        { bucket: 5, total: 1 },
      ]);
      expect(
        await database.users((users) => ({
          computed: users.id.plus(1),
          $distinct: true,
          $orderBy: users.id.plus(1).ascending,
        })),
      ).toEqual([{ computed: 2 }, { computed: 3 }, { computed: 4 }]);
      expect(
        await database.users((users) => ({
          first: users.id.plus(1),
          second: users.id.plus(2),
          $distinct: true,
          $orderBy: users.id.plus(2).ascending,
        })),
      ).toEqual([
        { first: 2, second: 3 },
        { first: 3, second: 4 },
        { first: 4, second: 5 },
      ]);
    } finally {
      await close();
    }
  });

  test("wide JSON objects retain all fields, nulls and precise numbers in nested and derived projections", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.posts((posts) => ({
        payload: {
          ...Object.fromEntries(
            Array.from({ length: 120 }, (_unused, position) => [
              `field_${position}`,
              posts.id,
            ]),
          ),
          views: posts.views,
          editorId: posts.editorId,
        },
        $where: posts.id.is(2),
      }));
      const expected = [
        {
          payload: {
            ...Object.fromEntries(
              Array.from({ length: 120 }, (_unused, position) => [
                `field_${position}`,
                2,
              ]),
            ),
            views: 30n,
            editorId: null,
          },
        },
      ];
      expect(await query).toEqual(expected);
      expect(
        await query.cte("wide")((wide) => ({ payload: wide.payload })),
      ).toEqual(expected);
      expect(
        await query.as("wide")((wide) => ({
          nested: { payload: wide.payload },
        })),
      ).toEqual(expected.map((row) => ({ nested: row })));
      const ranked = await database.posts((posts) => ({
        payload: {
          ...Object.fromEntries(
            Array.from({ length: 120 }, (_unused, position) => [
              `field_${position}`,
              posts.id,
            ]),
          ),
          position: rowNumber().over({ orderBy: posts.id.ascending }),
          metadata: posts.metadata,
          missing: posts.editorId,
        },
        $orderBy: posts.id.ascending,
      }));
      expect(ranked.map(({ payload }) => payload.position)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(ranked.map(({ payload }) => payload.metadata)).toEqual([
        "hello",
        "123",
        "true",
        "null",
      ]);
      expect(ranked.map(({ payload }) => payload.missing)).toEqual([
        2,
        null,
        null,
        null,
      ]);
    } finally {
      await close();
    }
  });

  test("JSON scalar strings are decoded once through nested objects, paths and CTEs", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.posts((posts) => ({
        id: posts.id,
        nested: { value: posts.metadata },
        $orderBy: posts.id.ascending,
      }));
      const expected = ["hello", "123", "true", "null"].map(
        (value, position) => ({ id: position + 1, nested: { value } }),
      );
      expect(await query).toEqual(expected);
      expect(
        await query.cte("strings")((strings) => ({
          id: strings.id,
          nested: strings.nested,
          $orderBy: strings.id.ascending,
        })),
      ).toEqual(expected);
      expect(
        await query.as("strings")((strings) => ({
          value: strings.nested.path("value"),
          $orderBy: strings.id.ascending,
        })),
      ).toEqual(expected.map(({ nested }) => nested));
    } finally {
      await close();
    }
  });

  test("lag and lead retain boolean and JSON conversion metadata through wrappers and CTEs", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.users((users) => ({
        id: users.id,
        active: lag(users.active).over({ orderBy: users.id.ascending }),
        metadata: lag(users.metadata).over({ orderBy: users.id.ascending }),
        next: lead(users.active, 1, false).over({
          orderBy: users.id.ascending,
        }),
        $orderBy: users.id.ascending,
      }));
      const expected = [
        { id: 1, active: null, metadata: null, next: false },
        { id: 2, active: true, metadata: { label: "alpha" }, next: true },
        { id: 3, active: false, metadata: { label: "beta" }, next: false },
      ];
      expect(await query).toEqual(expected);
      expect(
        await query.cte("lagged")((lagged) => ({
          id: lagged.id,
          active: lagged.active,
          metadata: lagged.metadata,
          next: lagged.next,
          $orderBy: lagged.id.ascending,
        })),
      ).toEqual(expected);
      expect(
        await query.as("lagged")((lagged) => ({
          nested: { active: lagged.active, metadata: lagged.metadata },
          $orderBy: lagged.id.ascending,
        })),
      ).toEqual(
        expected.map(({ active, metadata }) => ({
          nested: { active, metadata },
        })),
      );
      expect(
        await database.posts((posts) => ({
          previous: lag(posts.metadata, 1, "fallback").over({
            orderBy: posts.id.ascending,
          }),
          $orderBy: posts.id.ascending,
        })),
      ).toEqual(
        ["fallback", "hello", "123", "true"].map((previous) => ({ previous })),
      );
    } finally {
      await close();
    }
  });

  test("coalesced optional objects and collections preserve nested codecs and fallbacks", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.posts((posts) => ({
        id: posts.id,
        editor: coalesce(
          posts.editor((editor) => ({
            name: editor.name,
            active: editor.active,
          })),
          {
            name: "nobody",
            active: false,
          },
        ),
        comments: coalesce(
          posts.comments((comments) => ({
            body: comments.body,
            $orderBy: comments.id.ascending,
          })),
          [],
        ),
        $where: posts.id.atMost(2),
        $orderBy: posts.id.ascending,
      }));
      const expected = [
        {
          id: 1,
          editor: { name: "Grace", active: false },
          comments: [{ body: "A" }, { body: "B" }],
        },
        {
          id: 2,
          editor: { name: "nobody", active: false },
          comments: [{ body: "C" }],
        },
      ];
      expect(await query).toEqual(expected);
      expect(
        await query.cte("wrapped")((wrapped) => ({
          id: wrapped.id,
          editor: wrapped.editor,
          comments: wrapped.comments,
          $orderBy: wrapped.id.ascending,
        })),
      ).toEqual(expected);
      expect(
        await query.as("wrapped")((wrapped) => ({
          nested: { editor: wrapped.editor, comments: wrapped.comments },
          $orderBy: wrapped.id.ascending,
        })),
      ).toEqual(
        expected.map(({ editor, comments }) => ({
          nested: { editor, comments },
        })),
      );
    } finally {
      await close();
    }
  });

  test("repeated filtered counts share execution while distinct filters and volatile SQL stay independent", async () => {
    const { database, driver, close } = await fixture();

    try {
      const query = prepare({ minimum: int }, (parameters) =>
        database.users((users) => ({
          id: users.id,
          total: users
            .posts((posts) => ({ $where: posts.id.above(parameters.minimum) }))
            .count(),
          $where: users
            .posts((posts) => ({ $where: posts.id.above(parameters.minimum) }))
            .count()
            .above(0),
          $orderBy: [
            users
              .posts((posts) => ({
                $where: posts.id.above(parameters.minimum),
              }))
              .count().descending,
            users.id.ascending,
          ],
        })),
      );
      expect(await query.execute({ minimum: 0 })).toEqual([
        { id: 1, total: 2 },
        { id: 2, total: 1 },
        { id: 3, total: 1 },
      ]);
      expect(await query.execute({ minimum: 2 })).toEqual([
        { id: 2, total: 1 },
        { id: 3, total: 1 },
      ]);
      expect(
        await database.users((users) => ({
          id: users.id,
          total: users.posts.count(),
          $where: users
            .posts((posts) => ({ $where: posts.id.above(2) }))
            .count()
            .above(0),
          $orderBy: users.id.ascending,
        })),
      ).toEqual([
        { id: 2, total: 1 },
        { id: 3, total: 1 },
      ]);
      const volatile = database.users((users) => ({
        total: users
          .posts((posts) => ({ $where: sql<number>`random()`.above(0) }))
          .count(),
        $where: users
          .posts((posts) => ({ $where: sql<number>`random()`.above(0) }))
          .count()
          .above(0),
      }));
      expect(volatile.toSQL().sql).not.toContain("LATERAL");

      if (dialect === "postgres") {
        const compiled = query.toSQL({ minimum: 0 });
        const result = await driver.execute({
          ...compiled,
          sql: `EXPLAIN (ANALYZE, FORMAT JSON) ${compiled.sql}`,
        });
        const rows = Array.isArray(result) ? result : result.rows;
        const aggregates: Record<string, unknown>[] = [];

        const visit = (node: Record<string, unknown>): void => {
          if (node["Node Type"] === "Aggregate") {
            aggregates.push(node);
          }

          (node.Plans as Record<string, unknown>[] | undefined)?.forEach(visit);
        };

        visit(
          (rows[0]!["QUERY PLAN"] as { Plan: Record<string, unknown> }[])[0]!
            .Plan,
        );
        expect(aggregates).toHaveLength(1);
        expect(aggregates[0]!["Actual Loops"]).toBe(3);
      }
    } finally {
      await close();
    }
  });

  test("cursor pages match full ordering for single, compound, mixed-direction and nullable keys", async () => {
    const { database, close } = await fixture();

    try {
      for (const ascending of [true, false]) {
        for (const mode of [
          "single",
          "compound",
          "mixed",
          "nullable",
        ] as const) {
          const query = database.posts((posts) => ({
            id: posts.id,
            views: posts.views,
            editorId: posts.editorId,
            $orderBy: (() => {
              const identifier = ascending
                ? posts.id.ascending
                : posts.id.descending;

              return mode === "single"
                ? identifier
                : [
                    mode === "nullable"
                      ? ascending
                        ? posts.editorId.ascending
                        : posts.editorId.descending
                      : ascending
                        ? posts.views.ascending
                        : posts.views.descending,
                    mode === "mixed"
                      ? ascending
                        ? posts.id.descending
                        : posts.id.ascending
                      : identifier,
                  ];
            })(),
          }));
          const expected = await query;

          for (const size of [1, 2]) {
            const rows: typeof expected = [];
            let after: Awaited<ReturnType<typeof query.page>>["nextCursor"] =
              null;

            for (let iteration = 0; iteration <= expected.length; iteration++) {
              const page = await query.page({ size, after });
              rows.push(...page.items);
              after = page.nextCursor;

              if (!after) {
                break;
              }
            }

            expect(after).toBeNull();
            expect(rows).toEqual(expected);
          }
        }
      }
    } finally {
      await close();
    }
  });
};
