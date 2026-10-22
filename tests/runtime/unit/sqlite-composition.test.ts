import { expect, test } from "bun:test";
import {
  schema,
  createDatabase,
  int,
  text,
  bigint,
  numeric,
  jsonb,
  bool,
  timestamptz,
  prepare,
} from "../../../packages/runtime/src";
import { sqlite } from "../../../packages/runtime/src/driver";

test("SQLite cursor pages agree with database ordering for default and explicit null placement", async () => {
  const driver = sqlite();
  const database = createDatabase({
    schema: schema({ records: { id: int, label: text.nullable } }),
    driver,
  });
  driver.createTables(database);

  try {
    await database.records.insert([
      { id: 1, label: null },
      { id: 2, label: "a" },
      { id: 3, label: "b" },
      { id: 4, label: null },
      { id: 5, label: "a" },
    ]);

    for (const ascending of [true, false]) {
      for (const nulls of [undefined, "first", "last"] as const) {
        const query = database.records((records) => ({
          id: records.id,
          label: records.label,
          $orderBy: (() => {
            const ordering = ascending
              ? records.label.ascending
              : records.label.descending;

            return [
              nulls === "first"
                ? ordering.nullsFirst
                : nulls === "last"
                  ? ordering.nullsLast
                  : ordering,
              records.id.descending,
            ];
          })(),
        }));
        const expected = await query;

        for (const size of [1, 2, 3]) {
          const rows: typeof expected = [];
          let after: Awaited<ReturnType<typeof query.page>>["nextCursor"] =
            null;

          for (
            let pageNumber = 0;
            pageNumber <= expected.length;
            pageNumber++
          ) {
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
    await database.$close();
  }
});

test("SQLite derived tables and CTEs retain nested JSON conversion metadata", async () => {
  const driver = sqlite();
  const database = createDatabase({
    schema: schema({
      users: { id: int, name: text, active: bool },
      posts: ({ users }) => ({
        id: int,
        author: users,
        views: bigint,
        createdAt: timestamptz,
        metadata: jsonb<{ tags: string[] }>(),
      }),
    }),
    driver,
  });
  driver.createTables(database);
  const createdAt = new Date("2026-01-01T00:00:00Z");

  try {
    await database.users.insert([
      { id: 1, name: "Ada", active: true },
      { id: 2, name: "Grace", active: false },
    ]);
    await database.posts.insert({
      id: 1,
      authorId: 1,
      views: 9007199254740993n,
      createdAt,
      metadata: { tags: ["sql"] },
    });
    const query = database.users((users) => ({
      id: users.id,
      nested: { name: users.name, active: users.active },
      posts: users.posts((posts) => ({
        views: posts.views,
        createdAt: posts.createdAt,
        metadata: posts.metadata,
      })),
    }));
    const expected = [
      {
        id: 1,
        nested: { name: "Ada", active: true },
        posts: [
          { views: 9007199254740993n, createdAt, metadata: { tags: ["sql"] } },
        ],
      },
      { id: 2, nested: { name: "Grace", active: false }, posts: [] },
    ];

    for (const source of [query.as("projected"), query.cte("projected")]) {
      const selected = source((projected) => ({
        id: projected.id,
        nested: projected.nested,
        posts: projected.posts,
        $orderBy: projected.id.ascending,
      }));
      expect(await selected).toEqual(expected);
      expect(
        await selected.cte("again")((again) => ({
          id: again.id,
          nested: again.nested,
          posts: again.posts,
          $orderBy: again.id.ascending,
        })),
      ).toEqual(expected);
      expect(
        await source((projected) => ({
          wrapped: { nested: projected.nested, posts: projected.posts },
          $orderBy: projected.id.ascending,
        })),
      ).toEqual(
        expected.map(({ nested, posts }) => ({ wrapped: { nested, posts } })),
      );
    }

    const prepared = prepare({ id: int }, (parameters) =>
      query.cte("prepared")((prepared) => ({
        id: prepared.id,
        nested: prepared.nested,
        posts: prepared.posts,
        $where: prepared.id.is(parameters.id),
      })),
    );
    expect(await prepared.execute({ id: 1 })).toEqual([expected[0]!]);
  } finally {
    await database.$close();
  }
});

test("SQLite prepared search matches literal multiword and empty searches across executions", async () => {
  const driver = sqlite();
  const database = createDatabase({
    schema: schema({ posts: { id: int, title: text } }),
    driver,
  });
  driver.createTables(database);

  try {
    await database.posts.insert([
      { id: 1, title: "Bun loves SQL" },
      { id: 2, title: "SQL only" },
      { id: 3, title: "Bun" },
    ]);
    const prepared = prepare({ query: text }, (parameters) =>
      database.posts((posts) => ({
        id: posts.id,
        $where: posts.title.search(parameters.query),
        $orderBy: posts.id.ascending,
      })),
    );

    for (const query of [
      "SQL bun",
      "",
      " \t\n",
      "BUN",
      " bun\tSQL\n",
      "unknown",
      "SQL",
    ]) {
      expect(await prepared.execute({ query })).toEqual(
        await database.posts((posts) => ({
          id: posts.id,
          $where: posts.title.search(query),
          $orderBy: posts.id.ascending,
        })),
      );
    }

    const reused = prepare({ query: text }, (parameters) =>
      database.posts((posts) => ({
        id: posts.id,
        original: parameters.query,
        $where: posts.title.search(parameters.query),
      })),
    );
    expect(await reused.execute({ query: "SQL bun" })).toEqual([
      { id: 1, original: "SQL bun" },
    ]);
  } finally {
    await database.$close();
  }
});

test("SQLite recursive CTEs execute anchors, joins, distinct unions and prepared parameters", async () => {
  const driver = sqlite();
  const database = createDatabase({
    schema: schema({ nodes: { id: int, parentId: int.nullable } }),
    driver,
  });
  driver.createTables(database);

  try {
    await database.nodes.insert([
      { id: 1, parentId: null },
      { id: 2, parentId: 1 },
      { id: 3, parentId: 2 },
    ]);

    for (const unionAll of [true, false]) {
      const query = prepare({ start: int }, (parameters) =>
        database
          .nodes((nodes) => ({
            id: nodes.id,
            $where: nodes.id.is(parameters.start),
          }))
          .recursive(
            "tree",
            (tree) =>
              tree((tree, { innerJoin }) => {
                const nodes = innerJoin(database.nodes, (nodes) =>
                  nodes.parentId.is(tree.id),
                );

                return { id: nodes.id };
              }),
            { unionAll },
          )((tree) => ({ id: tree.id, $orderBy: tree.id.ascending })),
      );
      expect(await query.execute({ start: 1 })).toEqual([
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ]);
      expect(await query.execute({ start: 2 })).toEqual([{ id: 2 }, { id: 3 }]);
    }

    expect(
      await database
        .nodes((nodes) => ({
          id: nodes.id,
          $orderBy: nodes.id.ascending,
          $limit: 1,
        }))
        .recursive("sequence", (sequence) =>
          sequence((sequence) => ({
            id: sequence.id.plus(1),
            $where: sequence.id.below(3),
          })),
        )((sequence) => ({ id: sequence.id, $orderBy: sequence.id.ascending })),
    ).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  } finally {
    await database.$close();
  }
});

test("SQLite JSON paths distinguish numeric string keys from array positions", async () => {
  const driver = sqlite();
  const database = createDatabase({
    schema: schema({
      records: {
        id: int,
        metadata: jsonb<{
          "0": string;
          "01": string;
          rows: { "0": string }[];
        }>(),
      },
    }),
    driver,
  });
  driver.createTables(database);

  try {
    await database.records.insert({
      id: 1,
      metadata: { "0": "zero", "01": "leading", rows: [{ "0": "nested" }] },
    });
    const query = database.records((records) => ({
      zero: records.metadata.path("0"),
      leading: records.metadata.path("01"),
      nested: records.metadata.path("rows", 0, "0"),
      missing: records.metadata.path("rows", 1, "0"),
    }));
    expect(await query).toEqual([
      { zero: "zero", leading: "leading", nested: "nested", missing: null },
    ]);
    expect(
      await query.cte("paths")((paths) => ({
        zero: paths.zero,
        leading: paths.leading,
        nested: paths.nested,
        missing: paths.missing,
      })),
    ).toEqual(await query);
  } finally {
    await database.$close();
  }
});

test("SQLite OFFSET works without LIMIT in root and nested prepared queries", async () => {
  const driver = sqlite();
  const database = createDatabase({
    schema: schema({
      parents: { id: int },
      items: ({ parents }) => ({ id: int, parent: parents }),
    }),
    driver,
  });
  driver.createTables(database);

  try {
    await database.parents.insert({ id: 1 });
    await database.items.insert([
      { id: 1, parentId: 1 },
      { id: 2, parentId: 1 },
      { id: 3, parentId: 1 },
    ]);
    expect(
      await database.items((items) => ({
        id: items.id,
        $orderBy: items.id.ascending,
        $offset: 1,
      })),
    ).toEqual([{ id: 2 }, { id: 3 }]);
    const query = prepare({ skip: int }, (parameters) =>
      database.parents((parents) => ({
        items: parents.items((items) => ({
          id: items.id,
          $orderBy: items.id.ascending,
          $offset: parameters.skip,
        })),
      })),
    );
    expect(await query.execute({ skip: 1 })).toEqual([
      { items: [{ id: 2 }, { id: 3 }] },
    ]);
    expect(await query.execute({ skip: 3 })).toEqual([{ items: [] }]);
  } finally {
    await database.$close();
  }
});

test("scoped table aliases preserve composed filters in reads, joins and transactions", async () => {
  const driver = sqlite();
  const database = createDatabase({
    schema: schema({ records: { id: int, tenantId: int, label: text } }),
    driver,
  });
  driver.createTables(database);

  try {
    await database.records.insert([
      { id: 1, tenantId: 1, label: "visible" },
      { id: 2, tenantId: 2, label: "other tenant" },
      { id: 3, tenantId: 1, label: "hidden" },
    ]);
    const scoped = database
      .$scope({ records: (records) => records.tenantId.is(1) })
      .$scope({ records: (records) => records.label.is("visible") });
    const alias = scoped.records.as("visible").as("renamed");
    expect(await alias((renamed) => ({ id: renamed.id }))).toEqual([{ id: 1 }]);
    expect(
      await scoped.records((records, { crossJoin }) => {
        const renamed = crossJoin(alias);

        return {
          id: records.id,
          otherId: renamed.id,
        };
      }),
    ).toEqual([{ id: 1, otherId: 1 }]);
    expect(
      await scoped.$transaction(async (transaction) =>
        transaction.records
          .as("inside")((inside) => ({ id: inside.id }))
          .execute(),
      ),
    ).toEqual([{ id: 1 }]);
    expect(() =>
      scoped
        .records((records) => ({ $where: records.id.is(1) }))
        .as("filtered"),
    ).toThrow(/alias the table before/);
  } finally {
    await database.$close();
  }
});

test("SQLite nested arrays decode JSON elements and preserve numeric array shapes", async () => {
  const driver = sqlite();
  const database = createDatabase({
    schema: schema({
      parents: { id: int },
      items: ({ parents }) => ({
        id: int,
        parent: parents,
        objects: jsonb<{ name: string } | string | null>().array,
        amounts: numeric(30, 10).array,
        scores: bigint.array,
      }),
    }),
    driver,
  });
  driver.createTables(database);
  const values = {
    objects: [{ name: "Ada" }, "plain text", null],
    amounts: ["123456789012345.1234567890"],
    scores: [9007199254740993n],
  };

  try {
    await database.parents.insert({ id: 1 });
    expect(
      await database.items
        .insert({ id: 1, parentId: 1, ...values })
        .returning((items) => ({
          objects: items.objects,
          amounts: items.amounts,
          scores: items.scores,
        })),
    ).toEqual(values);
    expect(
      await database.items((items) => ({
        nested: {
          objects: items.objects,
          amounts: items.amounts,
          scores: items.scores,
        },
      })),
    ).toEqual([{ nested: values }]);
    expect(
      await database.parents((parents) => ({
        items: parents.items((items) => ({
          objects: items.objects,
          amounts: items.amounts,
          scores: items.scores,
        })),
      })),
    ).toEqual([{ items: [values] }]);
    expect(
      await database.items((items) => ({
        id: items.id,
        $where: items.objects.has({ name: "Ada" }),
      })),
    ).toEqual([{ id: 1 }]);
  } finally {
    await database.$close();
  }
});
