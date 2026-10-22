import { expect, test } from "bun:test";
import {
  schema,
  int,
  text,
  bool,
  bigint,
  timestamptz,
  jsonb,
  junction,
  createDatabase,
  count,
  sum,
  rowNumber,
  coalesce,
  prepare,
  self,
  oneOf,
} from "../../packages/runtime/src";
import { sqlite } from "../../packages/runtime/src/driver";
import { testDatabase } from "../../packages/kit/src/testing";

const model = schema({
  users: { id: int, name: text, active: bool, manager: self.nullable },
  posts: ({ users }) => ({
    id: int,
    author: users,
    editor: users.nullable.inverse("edited"),
    title: text,
    views: bigint,
    published: bool,
    state: oneOf("draft", "published").nullable,
    metadata: jsonb<string>(),
    createdAt: timestamptz,
  }),
  comments: ({ posts }) => ({ id: int, post: posts, body: text }),
  tags: { id: int, label: text },
  postTags: ({ posts, tags }) => junction({ post: posts, tag: tags }),
});
const createdAt = new Date("2026-01-01T12:30:00.000Z");

export const shapeTests = (dialect: "sqlite" | "postgres"): void => {
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
    const database =
      postgresFixture?.database ??
      createDatabase({ schema: model, driver: local! });

    await database.users.insert({
      id: 1,
      name: "Ada",
      active: true,
      managerId: null,
    });
    await database.users.insert({
      id: 2,
      name: "Grace",
      active: false,
      managerId: 1,
    });
    await database.users.insert({
      id: 3,
      name: "Lin",
      active: true,
      managerId: 2,
    });
    await database.posts.insert([
      {
        id: 1,
        authorId: 1,
        editorId: 2,
        title: "SQL",
        views: 9007199254740993n,
        published: true,
        state: "draft",
        metadata: "null",
        createdAt,
      },
      {
        id: 2,
        authorId: 1,
        editorId: null,
        title: "TS",
        views: 30n,
        published: true,
        state: "published",
        metadata: "123",
        createdAt,
      },
      {
        id: 3,
        authorId: 2,
        editorId: 1,
        title: "Draft",
        views: 20n,
        published: false,
        state: null,
        metadata: "true",
        createdAt,
      },
    ]);
    await database.comments.insert([
      { id: 1, postId: 1, body: "A" },
      { id: 2, postId: 1, body: "B" },
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
      close: postgresFixture ? postgresFixture.close : () => database.$close(),
    };
  };

  test("reusable shapes bind independently inside aliases and nullable relations", async () => {
    const { database, close } = await fixture();

    try {
      let invocations = 0;
      const userCard = database.users.shape((user) => {
        invocations += 1;

        return {
          name: user.name,
          posts: user.posts.count(),
          manager: user.manager((manager) => ({ name: manager.name })),
        };
      });
      expect(invocations).toBe(0);
      const query = database.posts((post) => ({
        author: post.author(userCard),
        editor: post.editor(userCard),
        $orderBy: post.id.ascending,
      }));
      expect(invocations).toBe(2);
      const ada = { name: "Ada", posts: 2, manager: null };
      const grace = { name: "Grace", posts: 1, manager: { name: "Ada" } };
      expect(await query).toEqual([
        { author: ada, editor: grace },
        { author: ada, editor: null },
        { author: grace, editor: ada },
      ]);
      expect(
        await database.users.as("member")(userCard)((user) => ({
          $where: user.id.is(1),
        })),
      ).toEqual([ada]);
      const postCard = database.posts.shape((post) => ({
        title: post.title,
        author: post.author(userCard),
      }));
      expect(
        await database.users((user) => ({
          posts: user.posts(postCard),
          $where: user.id.is(2),
        })),
      ).toEqual([{ posts: [{ title: "Draft", author: grace }] }]);
    } finally {
      await close();
    }
  });

  test("relation aggregates preserve filters, pagination, grouping and empty results", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.users((user) => {
        const page = user.posts((post) => ({
          $orderBy: post.id.ascending,
          $offset: 1,
          $limit: 1,
        }));

        return {
          name: user.name,
          total: user.posts.sum((post) => post.views),
          average: user
            .posts((post) => ({ $where: post.views.below(100n) }))
            .average((post) => post.views),
          earliest: user.posts.minimum((post) => post.createdAt),
          largest: user.posts.maximum((post) => post.views),
          pageTotal: page.sum((post) => post.views),
          pageCount: page.count(),
          groups: user
            .posts((post) => ({ $groupBy: [post.published] }))
            .sum(() => count()),
          $orderBy: user.id.ascending,
        };
      });
      expect(await query((user) => ({ $where: user.id.above(0) }))).toEqual([
        {
          name: "Ada",
          total: "9007199254741023",
          average: dialect === "postgres" ? "30.0000000000000000" : "30",
          earliest: createdAt,
          largest: 9007199254740993n,
          pageTotal: "30",
          pageCount: 1,
          groups: "2",
        },
        {
          name: "Grace",
          total: "20",
          average: dialect === "postgres" ? "20.0000000000000000" : "20",
          earliest: createdAt,
          largest: 20n,
          pageTotal: null,
          pageCount: 0,
          groups: "1",
        },
        {
          name: "Lin",
          total: null,
          average: null,
          earliest: null,
          largest: null,
          pageTotal: null,
          pageCount: 0,
          groups: null,
        },
      ]);
      const paged = prepare({ size: int, offset: int }, (parameters) =>
        database.users((user) => ({
          total: user
            .posts((post) => ({
              $orderBy: post.id.ascending,
              $limit: parameters.size,
              $offset: parameters.offset,
            }))
            .sum((post) => post.views),
          $where: user.id.is(1),
        })),
      );
      expect(await paged.execute({ size: 1, offset: 1 })).toEqual([
        { total: "30" },
      ]);
      expect(await paged.execute({ size: 0, offset: 0 })).toEqual([
        { total: null },
      ]);
      expect(
        await database.users((user) => ({
          groups: user
            .posts((post) => ({ $groupBy: [post.published] }))
            .count(),
          distinct: user.posts(() => ({ $distinct: true })).count(),
          $where: user.id.is(1),
        })),
      ).toEqual([{ groups: 1, distinct: 2 }]);
    } finally {
      await close();
    }
  });

  test("enum match preserves literals, expressions and codecs through relations and CTEs", async () => {
    const { database, close } = await fixture();

    try {
      const card = database.posts.shape((post) => ({
        label: post.state.match({
          draft: "Черновик",
          published: "Опубликовано",
        }),
        views: post.state.match({ draft: post.views, published: 42n }),
        enabled: post.state.match({ draft: false, published: true }),
        createdAt: post.state.match({
          draft: post.createdAt,
          published: createdAt,
        }),
      }));
      const expected = [
        {
          label: "Черновик" as const,
          views: 9007199254740993n,
          enabled: false,
          createdAt,
        },
        {
          label: "Опубликовано" as const,
          views: 42n,
          enabled: true,
          createdAt,
        },
        { label: null, views: null, enabled: null, createdAt: null },
      ];
      const query = database.posts(card)((post) => ({
        $orderBy: post.id.ascending,
      }));
      expect(await query).toEqual(expected);
      const projected = query.cte("cards");
      expect(await projected((card) => ({ ...card }))).toEqual(expected);
      expect(
        await database.users((user) => ({
          posts: user.posts((post) => ({ $orderBy: post.id.ascending }))(card),
          $where: user.id.is(1),
        })),
      ).toEqual([{ posts: expected.slice(0, 2) }]);
      const prepared = prepare({ views: bigint }, (parameters) =>
        database.posts((post) => ({
          views: post.state.match({
            draft: parameters.views,
            published: post.views,
          }),
          $where: post.id.is(1),
        })),
      );
      expect(await prepared.execute({ views: 9007199254740995n })).toEqual([
        { views: 9007199254740995n },
      ]);
      expect(
        await database.posts((post, { sql }) => ({
          views: post.state.match({
            draft: sql<bigint>`${post.views}`,
            published: 42n,
          }),
          $where: post.id.is(1),
        })),
      ).toEqual([{ views: 9007199254740993n }]);
      expect(() =>
        database.posts((post) => ({
          // @ts-expect-error runtime validation also rejects missing branches
          label: post.state.match({ draft: "Draft" }),
        })),
      ).toThrow("every enum value");
    } finally {
      await close();
    }
  });

  test("FK JOINs infer self references, optional ancestors and explicit join kinds", async () => {
    const { database, close } = await fixture();

    try {
      const hierarchy = database.users((user, { join }) => {
        const manager = join(user.managerId);
        const director = join(manager.managerId);
        const repeated = join(user.manager);

        return {
          employee: user.name,
          manager: manager.name,
          director: director.name,
          repeated: repeated.name,
          $orderBy: user.id.ascending,
        };
      });
      expect(await hierarchy).toEqual([
        { employee: "Ada", manager: null, director: null, repeated: null },
        { employee: "Grace", manager: "Ada", director: null, repeated: "Ada" },
        {
          employee: "Lin",
          manager: "Grace",
          director: "Ada",
          repeated: "Grace",
        },
      ]);
      expect(hierarchy.toSQL().sql.match(/LEFT JOIN/g)).toHaveLength(3);
      expect(
        await database.users((user, { innerJoin, leftJoin }) => {
          const manager = innerJoin(user.managerId);
          const director = leftJoin(manager.managerId);

          return {
            employee: user.name,
            manager: manager.name,
            director: director.name,
            $orderBy: user.id.ascending,
          };
        }),
      ).toEqual([
        { employee: "Grace", manager: "Ada", director: null },
        { employee: "Lin", manager: "Grace", director: "Ada" },
      ]);
      expect(
        await database.posts((post, { join }) => {
          const author = join(post.authorId);
          const editor = join(post.editorId);

          return {
            title: post.title,
            author: author.name,
            editor: editor.name,
            $orderBy: post.id.ascending,
          };
        }),
      ).toEqual([
        { title: "SQL", author: "Ada", editor: "Grace" },
        { title: "TS", author: "Ada", editor: null },
        { title: "Draft", author: "Grace", editor: "Ada" },
      ]);
      const optional = database.users((user, { join }) => {
        const post = join(user.posts);
        const author = join(post.authorId);

        return {
          name: user.name,
          author: author.name,
          $orderBy: [user.id.ascending, post.id.ascending],
        };
      });
      expect(await optional).toEqual([
        { name: "Ada", author: "Ada" },
        { name: "Ada", author: "Ada" },
        { name: "Grace", author: "Grace" },
        { name: "Lin", author: null },
      ]);
      expect(optional.toSQL().sql.match(/LEFT JOIN/g)).toHaveLength(2);
      expect(
        await database.posts((posts, { join }) => {
          const editor = join(posts.editorId);

          return {
            title: posts.title,
            editor: editor.name,
            $orderBy: posts.id.ascending,
          };
        }),
      ).toEqual([
        { title: "SQL", editor: "Grace" },
        { title: "TS", editor: null },
        { title: "Draft", editor: "Ada" },
      ]);
    } finally {
      await close();
    }
  });

  test("repeated reverse and junction JOINs preserve independent row multiplication", async () => {
    const { database, close } = await fixture();

    try {
      expect(
        await database.users((user, { innerJoin }) => {
          const first = innerJoin(user.posts);
          const second = innerJoin(user.posts);

          return {
            name: user.name,
            first: first.title,
            second: second.title,
            $where: first.id.isNot(second.id),
            $orderBy: first.id.ascending,
          };
        }),
      ).toEqual([
        { name: "Ada", first: "SQL", second: "TS" },
        { name: "Ada", first: "TS", second: "SQL" },
      ]);
      expect(
        await database.posts((post, { leftJoin }) => {
          const first = leftJoin(post.tags);
          const second = leftJoin(post.tags);

          return {
            first: first.label,
            second: second.label,
            $where: post.id.is(1),
            $orderBy: [first.id.ascending, second.id.ascending],
          };
        }),
      ).toEqual([
        { first: "sql", second: "sql" },
        { first: "sql", second: "ts" },
        { first: "ts", second: "sql" },
        { first: "ts", second: "ts" },
      ]);
      expect(
        await database.users((user, { crossJoin }) => {
          const first = crossJoin(user.managerId);
          const second = crossJoin(database.users);

          return {
            first: first.name,
            second: second.name,
            $where: [user.id.is(1), first.id.is(3), second.id.is(2)],
          };
        }),
      ).toEqual([{ first: "Lin", second: "Grace" }]);
      expect(
        await database.posts((posts, { crossJoin }) => {
          const author = crossJoin(posts.authorId);

          return {
            name: author.name,
            $distinct: true,
            $orderBy: author.name.ascending,
          };
        }),
      ).toEqual([{ name: "Ada" }, { name: "Grace" }, { name: "Lin" }]);
    } finally {
      await close();
    }
  });

  test("explicit-source JOINs, CTEs and derived tables receive independent automatic aliases", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.users((user, { leftJoin }) => {
        const manager = leftJoin(database.users, (manager) =>
          manager.id.is(user.managerId),
        );
        const director = leftJoin(database.users, (director) =>
          director.id.is(manager.managerId),
        );

        return {
          name: user.name,
          manager: manager.name,
          director: director.name,
          $orderBy: user.id.ascending,
        };
      });
      expect(await query).toEqual([
        { name: "Ada", manager: null, director: null },
        { name: "Grace", manager: "Ada", director: null },
        { name: "Lin", manager: "Grace", director: "Ada" },
      ]);
      const selected = database.users((user) => ({
        id: user.id,
        name: user.name,
        managerId: user.managerId,
      }));

      for (const source of [selected.as("people"), selected.cte("people")]) {
        const prepared = prepare({ employee: int }, (parameters) =>
          source((user, { leftJoin }) => {
            const manager = leftJoin(source, (manager) =>
              manager.id.is(user.managerId),
            );
            const director = leftJoin(source, (director) =>
              director.id.is(manager.managerId),
            );

            return {
              name: user.name,
              manager: manager.name,
              director: director.name,
              peers: source((peer) => ({
                name: peer.name,
                $where: peer.managerId.is(user.managerId),
                $orderBy: peer.id.ascending,
              })),
              $where: user.id.is(parameters.employee),
            };
          }),
        );
        expect(await prepared.execute({ employee: 3 })).toEqual([
          {
            name: "Lin",
            manager: "Grace",
            director: "Ada",
            peers: [{ name: "Lin" }],
          },
        ]);
      }
    } finally {
      await close();
    }
  });

  test("alias-free correlation survives nested scopes, reusable queries and late outer paths", async () => {
    const { database, close } = await fixture();

    try {
      const eligible = database.users((users) => ({
        $where: users.id.atMost(3),
      }));
      const query = eligible((user) => ({
        name: user.name,
        peers: eligible((peer) => ({
          name: peer.name,
          director: user.manager.manager.name,
          reports: database.users((report) => ({
            name: report.name,
            owner: user.name,
            $where: report.managerId.is(peer.id),
            $orderBy: report.id.ascending,
          })),
          $where: peer.id.isNot(user.id),
          $orderBy: peer.id.ascending,
        })),
        $where: user.id.is(3),
      }));
      expect(await query).toEqual([
        {
          name: "Lin",
          peers: [
            {
              name: "Ada",
              director: "Ada",
              reports: [{ name: "Grace", owner: "Lin" }],
            },
            {
              name: "Grace",
              director: "Ada",
              reports: [{ name: "Lin", owner: "Lin" }],
            },
          ],
        },
      ]);
      expect(
        await eligible((users) => ({
          name: users.name,
          $orderBy: users.id.ascending,
        })),
      ).toEqual([{ name: "Ada" }, { name: "Grace" }, { name: "Lin" }]);
      expect(
        await database.users((user, { exists }) => ({
          name: user.name,
          manager: database
            .users((manager) => ({
              name: manager.name,
              $where: manager.id.is(user.managerId),
            }))
            .scalar(),
          $where: exists(
            database.users((users) => ({
              id: users.id,
              $where: users.managerId.is(user.id),
            })),
          ),
          $orderBy: user.id.ascending,
        })),
      ).toEqual([
        { name: "Ada", manager: null },
        { name: "Grace", manager: "Ada" },
      ]);
      expect(
        await database.users((users) => ({
          name: users.name,
          reports: database.users((report) => ({
            name: report.name,
            $where: report.managerId.is(users.id),
          })),
          $where: users.id.is(1),
        })),
      ).toEqual([{ name: "Ada", reports: [{ name: "Grace" }] }]);
    } finally {
      await close();
    }
  });

  test("inferred JOINs apply scopes to each occurrence without losing optional rows", async () => {
    const { database, close } = await fixture();

    try {
      const scoped = database.$scope({ users: (user) => user.active.is(true) });
      expect(
        await scoped.users((user, { join, crossJoin }) => {
          const manager = join(user.managerId);
          const director = join(manager.managerId);
          const peer = crossJoin(user.manager);

          return {
            name: user.name,
            manager: manager.name,
            director: director.name,
            peer: peer.name,
            $where: peer.id.is(1),
            $orderBy: user.id.ascending,
          };
        }),
      ).toEqual([
        { name: "Ada", manager: null, director: null, peer: "Ada" },
        { name: "Lin", manager: null, director: null, peer: "Ada" },
      ]);
      expect(
        await scoped.posts((post, { innerJoin, leftJoin }) => {
          const author = innerJoin(post.authorId);
          const editor = leftJoin(post.editorId);

          return {
            title: post.title,
            author: author.name,
            editor: editor.name,
            $orderBy: post.id.ascending,
          };
        }),
      ).toEqual([
        { title: "SQL", author: "Ada", editor: null },
        { title: "TS", author: "Ada", editor: null },
      ]);
    } finally {
      await close();
    }
  });

  test("shape tools retain smart JOIN nullability, scoped CROSS JOINs and DISTINCT", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.posts((post, { join }) => {
        const author = join(post.author);
        const editor = join(post.editor);
        const manager = join(editor.manager);

        return {
          title: post.title,
          author: author.name,
          editor: editor.name,
          manager: manager.name,
          $orderBy: post.id.ascending,
        };
      });
      expect(query.toSQL().sql).toContain('INNER JOIN "users" AS "author"');
      expect(query.toSQL().sql).toContain('LEFT JOIN "users" AS "editor"');
      expect(query.toSQL().sql).toContain('LEFT JOIN "users" AS "manager"');
      expect(await query).toEqual([
        { title: "SQL", author: "Ada", editor: "Grace", manager: "Ada" },
        { title: "TS", author: "Ada", editor: null, manager: null },
        { title: "Draft", author: "Grace", editor: "Ada", manager: null },
      ]);
      const scoped = database.$scope({ tags: (tag) => tag.id.is(2) });
      expect(
        await scoped.posts((post, { crossJoin }) => {
          const tag = crossJoin(scoped.tags);

          return {
            authorId: post.authorId,
            tag: tag.label,
            $distinct: true,
            $orderBy: post.authorId.ascending,
          };
        }),
      ).toEqual([
        { authorId: 1, tag: "ts" },
        { authorId: 2, tag: "ts" },
      ]);
      expect(
        await database.posts((post, { whereNotNull }) => ({
          editorId: whereNotNull(post.editorId),
          $orderBy: post.id.ascending,
        })),
      ).toEqual([{ editorId: 2 }, { editorId: 1 }]);
    } finally {
      await close();
    }
  });

  test("shape SQL helpers compose scalar subqueries, predicates, aggregates and windows", async () => {
    const { database, close } = await fixture();

    try {
      expect(
        await database.users(
          (user, { and, or, not, when, exists, notExists, coalesce }) => ({
            name: user.name,
            latest: database
              .posts((post, { maximum }) => ({
                title: maximum(post.title),
                $where: post.authorId.is(user.id),
              }))
              .scalar(),
            total: coalesce(
              database
                .posts((post, { count }) => ({
                  total: count(),
                  $where: post.authorId.is(user.id),
                }))
                .scalar(),
              0,
            ),
            $where: and(
              or(user.active.is(true), not(user.active.is(true))),
              when(1, (minimum) => user.id.atLeast(minimum)),
              exists(
                database.posts((post) => ({
                  id: post.id,
                  $where: post.authorId.is(user.id),
                })),
              ),
              notExists(
                database.posts.as("impossible")((post) => ({
                  id: post.id,
                  $where: [post.authorId.is(user.id), post.id.below(0)],
                })),
              ),
            ),
            $orderBy: user.id.ascending,
          }),
        ),
      ).toEqual([
        { name: "Ada", latest: "TS", total: 2 },
        { name: "Grace", latest: "Draft", total: 1 },
      ]);
      expect(
        await database
          .posts((post, { count, sum, average, minimum, maximum }) => ({
            total: count(),
            sum: sum(post.id),
            average: average(post.id),
            minimum: minimum(post.id),
            maximum: maximum(post.id),
            $where: post.id.atMost(2),
          }))
          .one(),
      ).toMatchObject({ total: 2, sum: "3", minimum: 1, maximum: 2 });
      expect(
        await database.posts(
          (
            post,
            { rowNumber, rank, denseRank, lag, lead, over, sum, sql },
          ) => ({
            id: post.id,
            position: rowNumber().over({ orderBy: post.id.ascending }),
            rank: rank().over({ orderBy: post.id.ascending }),
            dense: denseRank().over({ orderBy: post.id.ascending }),
            previous: lag(post.id).over({ orderBy: post.id.ascending }),
            next: lead(post.id).over({ orderBy: post.id.ascending }),
            running: over(sum(post.id), { orderBy: post.id.ascending }),
            constant: sql<number>`1`,
            $where: post.id.in(
              database.posts.as("eligible")((post) => ({
                id: post.id,
                $where: post.id.atMost(2),
              })),
            ),
            $orderBy: post.id.ascending,
          }),
        ),
      ).toEqual([
        {
          id: 1,
          position: 1,
          rank: 1,
          dense: 1,
          previous: null,
          next: 2,
          running: "1",
          constant: 1,
        },
        {
          id: 2,
          position: 2,
          rank: 2,
          dense: 2,
          previous: 1,
          next: null,
          running: "3",
          constant: 1,
        },
      ]);
      const pageQuery = database.users((user) => ({
        id: user.id,
        name: user.name,
        $orderBy: user.id.ascending,
      }));
      const first = await pageQuery.page({ size: 2 });
      expect(first.items.map((row) => row.name)).toEqual(["Ada", "Grace"]);
      expect(
        (await pageQuery.page({ size: 2, after: first.nextCursor })).items.map(
          (row) => row.name,
        ),
      ).toEqual(["Lin"]);
    } finally {
      await close();
    }
  });

  test("shape row locks validate options and respect the dialect", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.users((user) => ({
        id: user.id,
        $where: user.id.is(1),
        $forUpdate: { of: ["users"], noWait: true },
      }));

      if (dialect === "sqlite") {
        expect(() => query.toSQL()).toThrow(/row locks.*"sqlite"/);
        await expect(query.execute()).rejects.toThrow(/row locks.*"sqlite"/);
      } else {
        expect(query.toSQL().sql).toContain('FOR UPDATE OF "users" NOWAIT');
        await database.$transaction(async (transaction) => {
          expect(
            await transaction.users((user) => ({
              id: user.id,
              $where: user.id.is(1),
              $forShare: { skipLocked: true },
            })),
          ).toEqual([{ id: 1 }]);
        });
      }

      expect(() =>
        database.users((user) => ({
          id: user.id,
          $forUpdate: true,
          $forShare: true,
        })),
      ).toThrow(/choose either/);
      expect(() =>
        database.users((user) => ({
          id: user.id,
          $forUpdate: { of: ["missing"] },
        })),
      ).toThrow(/existing query aliases/);
      expect(() =>
        database.users((user) => ({
          id: user.id,
          $forUpdate: { noWait: true, skipLocked: true },
        })),
      ).toThrow(/choose either/);
    } finally {
      await close();
    }
  });

  test("shapes nest filtered relations, nullable objects and junctions with lossless codecs", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.users((user) => {
        const published = user.posts((posts) => ({
          $where: posts.published.is(true),
        }));

        return {
          name: user.name,
          publications: published.count(),
          posts: published((post, { innerJoin }) => {
            const author = innerJoin(post.author);

            return {
              title: post.title,
              author: author.name,
              views: post.views,
              metadata: post.metadata,
              createdAt: post.createdAt,
              editor: post.editor((editor) => ({ name: editor.name })),
              tags: post.tags((tag) => ({
                label: tag.label,
                $orderBy: tag.id.ascending,
              })),
              comments: post.comments((comment) => ({
                body: comment.body,
                post: comment.post(({ title }) => ({ title })),
                $orderBy: comment.id.descending,
                $limit: 1,
              })),
              $orderBy: post.id.ascending,
              $limit: 2,
            };
          }),
          $orderBy: user.id.ascending,
        };
      });
      expect(await query).toEqual([
        {
          name: "Ada",
          publications: 2,
          posts: [
            {
              title: "SQL",
              author: "Ada",
              views: 9007199254740993n,
              metadata: "null",
              createdAt,
              editor: { name: "Grace" },
              tags: [{ label: "sql" }, { label: "ts" }],
              comments: [{ body: "B", post: { title: "SQL" } }],
            },
            {
              title: "TS",
              author: "Ada",
              views: 30n,
              metadata: "123",
              createdAt,
              editor: null,
              tags: [{ label: "ts" }],
              comments: [],
            },
          ],
        },
        { name: "Grace", publications: 0, posts: [] },
        { name: "Lin", publications: 0, posts: [] },
      ]);
    } finally {
      await close();
    }
  });

  test("local JOINs preserve ON filtering, nullable paths and SQL row multiplication", async () => {
    const { database, close } = await fixture();

    try {
      const query = database.posts((post, { leftJoin, innerJoin }) => {
        const author = innerJoin(post.author);
        const editor = leftJoin(database.users.as("reviewer"), (user) => [
          user.id.is(post.editorId),
          user.active.is(true),
        ]);

        return {
          title: post.title,
          author: author.name,
          editor: editor.name,
          manager: editor.manager.name,
          $orderBy: post.id.ascending,
        };
      });
      expect(await query).toEqual([
        { title: "SQL", author: "Ada", editor: null, manager: null },
        { title: "TS", author: "Ada", editor: null, manager: null },
        { title: "Draft", author: "Grace", editor: "Ada", manager: null },
      ]);
      expect(
        await database.users((user, { innerJoin }) => {
          const post = innerJoin(user.posts);
          const tag = innerJoin(post.tags);

          return {
            name: user.name,
            title: post.title,
            tag: tag.label,
            $orderBy: [post.id.ascending, tag.id.ascending],
          };
        }),
      ).toEqual([
        { name: "Ada", title: "SQL", tag: "sql" },
        { name: "Ada", title: "SQL", tag: "ts" },
        { name: "Ada", title: "TS", tag: "ts" },
      ]);
      const scoped = database.$scope({ users: (user) => user.active.is(true) });
      expect(
        await scoped.posts((post, { leftJoin }) => {
          const editor = leftJoin(scoped.users.as("editor"), (user) =>
            user.id.is(post.editorId),
          );

          return {
            title: post.title,
            editor: editor.name,
            $orderBy: post.id.ascending,
          };
        }),
      ).toEqual([
        { title: "SQL", editor: null },
        { title: "TS", editor: null },
        { title: "Draft", editor: "Ada" },
      ]);
      expect(
        await database.posts((post, { leftJoin }) => {
          const manager = leftJoin(database.users.as("manager"), (manager) =>
            manager.id.is(post.author.managerId),
          );

          return {
            title: post.title,
            manager: manager.name,
            $orderBy: post.id.ascending,
          };
        }),
      ).toEqual([
        { title: "SQL", manager: null },
        { title: "TS", manager: null },
        { title: "Draft", manager: "Ada" },
      ]);
    } finally {
      await close();
    }
  });

  test("self JOINs and arbitrary correlated nested SELECTs share lexical handles", async () => {
    const { database, close } = await fixture();

    try {
      expect(
        await database.users((user, { leftJoin }) => {
          const manager = leftJoin(database.users.as("manager"), (manager) =>
            manager.id.is(user.managerId),
          );
          const director = leftJoin(database.users.as("director"), (director) =>
            director.id.is(manager.managerId),
          );

          return {
            name: user.name,
            manager: manager.name,
            director: director.name,
            colleagues: database.users.as("colleague")((colleague) => ({
              name: colleague.name,
              owner: user.name,
              $where: [colleague.id.isNot(user.id), colleague.active.is(true)],
              $orderBy: colleague.id.ascending,
              $limit: 1,
            })),
            $orderBy: user.id.ascending,
          };
        }),
      ).toEqual([
        {
          name: "Ada",
          manager: null,
          director: null,
          colleagues: [{ name: "Lin", owner: "Ada" }],
        },
        {
          name: "Grace",
          manager: "Ada",
          director: null,
          colleagues: [{ name: "Ada", owner: "Grace" }],
        },
        {
          name: "Lin",
          manager: "Grace",
          director: "Ada",
          colleagues: [{ name: "Ada", owner: "Lin" }],
        },
      ]);
      const scoped = database.$scope({
        posts: (post) => post.published.is(true),
      });
      expect(
        await database.users((user) => ({
          name: user.name,
          posts: scoped.posts((post) => ({
            title: post.title,
            owner: user.name,
            $where: post.authorId.is(user.id),
            $orderBy: post.id.ascending,
          })),
          $where: user.id.is(1),
        })),
      ).toEqual([
        {
          name: "Ada",
          posts: [
            { title: "SQL", owner: "Ada" },
            { title: "TS", owner: "Ada" },
          ],
        },
      ]);
    } finally {
      await close();
    }
  });

  test("callable CTEs compose windows, grouped analytics, prepared limits and nested arrays", async () => {
    const { database, close } = await fixture();

    try {
      const query = prepare({ top: int, offset: int }, (parameters) => {
        const ranked = database
          .posts((post) => ({
            authorId: post.authorId,
            title: post.title,
            views: post.views,
            position: rowNumber().over({
              partitionBy: [post.authorId],
              orderBy: [post.views.descending, post.id.ascending],
            }),
            $where: post.published.is(true),
          }))
          .cte("ranked_posts");
        const topPosts = ranked((post) => ({
          authorId: post.authorId,
          title: post.title,
          views: post.views,
          position: post.position,
          $where: post.position.atMost(parameters.top),
        })).cte("top_posts");
        const totals = database
          .posts((post) => ({
            authorId: post.authorId,
            publications: count(),
            views: sum(post.views),
            $where: post.published.is(true),
            $groupBy: [post.authorId],
            $having: [count().above(0)],
          }))
          .cte("totals");

        return database.users((user, { leftJoin }) => {
          const total = leftJoin(totals, (total) => total.authorId.is(user.id));

          return {
            name: user.name,
            statistics: {
              publications: coalesce(total.publications, 0),
              views: total.views,
            },
            best: topPosts((post) => ({
              title: post.title,
              views: post.views,
              position: post.position,
              $where: post.authorId.is(user.id),
              $orderBy: post.position.ascending,
              $limit: parameters.top,
            })),
            $where: user.active.is(true),
            $orderBy: user.id.ascending,
            $offset: parameters.offset,
          };
        });
      });
      expect(await query.execute({ top: 1, offset: 0 })).toEqual([
        {
          name: "Ada",
          statistics: { publications: 2, views: "9007199254741023" },
          best: [{ title: "SQL", views: 9007199254740993n, position: 1 }],
        },
        { name: "Lin", statistics: { publications: 0, views: null }, best: [] },
      ]);
      expect(await query.execute({ top: 2, offset: 1 })).toEqual([
        { name: "Lin", statistics: { publications: 0, views: null }, best: [] },
      ]);
      expect(() => query.toSQL({ top: -1, offset: 0 })).toThrow(/nonnegative/);
    } finally {
      await close();
    }
  });

  test("shape execution is deferred and controls compose with transactions", async () => {
    const { database, close } = await fixture();

    try {
      const shape = database.posts((post) => ({
        title: post.title,
        $where: post.published.is(true),
        $orderBy: post.id.ascending,
      }));
      const filtered = database.posts((post) => ({
        $where: post.published.is(true),
      }));
      const selected = filtered((post) => ({ title: post.title }));
      const ordered = selected((post) => ({ $orderBy: post.id.ascending }));
      expect(shape.toSQL()).toEqual(ordered.toSQL());
      expect(await shape).toEqual(await ordered);
      expect(await ordered(() => ({ $limit: 0 }))).toEqual([]);
      expect(await ordered).toEqual([{ title: "SQL" }, { title: "TS" }]);
      expect(
        await database.posts((posts, { innerJoin }) => {
          const users = innerJoin(database.users, (users) =>
            posts.authorId.is(users.id),
          );

          return {};
        })((post) => ({ title: post.title }))((posts) => ({ $limit: 1 })),
      ).toEqual([{ title: "SQL" }]);
      expect(
        await database.users
          .byId(1)((user) => ({ name: user.name }))
          .one(),
      ).toEqual({ name: "Ada" });
      expect(
        await database.$transaction(async (transaction) =>
          transaction
            .posts((post) => ({ title: post.title, $where: post.id.is(2) }))
            .one(),
        ),
      ).toEqual({ title: "TS" });
      expect(
        await database.users((users) => ({
          name: users.name,
          posts: database.posts((post) => ({
            title: post.title,
            $where: post.authorId.is(users.id),
            $orderBy: post.id.ascending,
          })),
          $where: users.id.is(1),
        })),
      ).toEqual([{ name: "Ada", posts: [{ title: "SQL" }, { title: "TS" }] }]);
      expect(
        await database.users((users) => ({
          name: users.name,
          posts: users.posts((posts) => ({
            title: posts.title,
            comments: database.comments((comment) => ({
              body: comment.body,
              title: posts.title,
              owner: users.name,
              $where: comment.postId.is(posts.id),
              $orderBy: comment.id.ascending,
            })),
          })),
          $where: users.id.is(1),
        })),
      ).toEqual([
        {
          name: "Ada",
          posts: [
            {
              title: "SQL",
              comments: [
                { body: "A", title: "SQL", owner: "Ada" },
                { body: "B", title: "SQL", owner: "Ada" },
              ],
            },
            { title: "TS", comments: [] },
          ],
        },
      ]);
    } finally {
      await close();
    }
  });
};
