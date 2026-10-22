import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  junction,
  schema,
  table,
  createDatabase,
  int,
  text,
  bigint,
  jsonb,
  timestamptz,
  oneOf,
  sql,
  prepare,
  customType,
  type PageCursor,
} from "../../../packages/runtime/src";
import { postgres } from "../../../packages/runtime/src/driver";
import { createSchemaSQL } from "../../../packages/kit/src";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "modular schema and query conveniences on PostgreSQL",
  () => {
    const driver = postgres({
      url: databaseUrl ?? "postgres://localhost/postgres",
      max: 1,
    });
    const namespace = `symmetria_magic_${crypto.randomUUID().replaceAll("-", "")}`;
    const authors = table({
      id: int.auto,
      email: text.unique,
      firstName: text,
      lastName: text,
      visits: bigint.default(9007199254740993n),
    }).computed((authors) => ({
      fullName: sql<string>`concat_ws(' ', ${authors.firstName}, ${authors.lastName})`,
    }));
    const posts = table({
      id: int.auto,
      title: text,
      author: authors.nullable.index,
      state: oneOf("draft", "published").default("draft"),
      createdAt: timestamptz.nullable,
      metadata: jsonb<{
        settings?: { theme: string };
        tags: string[];
      }>().default({ tags: [] }),
    });
    const tags = table({ id: int.auto, label: text });
    const postTags = junction({ post: posts, tag: tags });
    const appSchema = schema({ authors, posts, tags, postTags });
    const database = createDatabase({ schema: appSchema, driver });

    const run = (statement: string) =>
      driver.execute({ sql: statement, parameters: [] });

    beforeAll(async () => {
      await run(`CREATE SCHEMA "${namespace}"`);
      await run(`SET search_path TO "${namespace}"`);

      for (const query of createSchemaSQL(appSchema.$snapshot())) {
        await driver.execute(query);
      }
    });
    beforeEach(async () => {
      await run(
        "TRUNCATE authors, posts, tags, post_tags RESTART IDENTITY CASCADE",
      );
      await database.authors
        .insert([
          { email: "ada", firstName: "Ada", lastName: "Lovelace" },
          { email: "grace", firstName: "Grace", lastName: "Hopper" },
        ])
        .execute();
      await database.posts
        .insert([
          {
            title: "First",
            authorId: 1,
            state: "published",
            createdAt: new Date("2026-01-01"),
            metadata: { settings: { theme: "dark" }, tags: ["sql"] },
          },
          {
            title: "Second",
            authorId: 1,
            state: "draft",
            createdAt: new Date("2026-01-01"),
          },
          {
            title: "Third",
            authorId: 2,
            state: "published",
            createdAt: new Date("2026-02-01"),
          },
          { title: "Fourth", authorId: null },
          { title: "Fifth", authorId: null },
        ])
        .execute();
      await database.tags.insert({ label: "postgres" }).execute();
      await database.postTags.insert({ postId: 1, tagId: 1 }).execute();
    });
    afterAll(async () => {
      try {
        await run(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      } finally {
        await database.$close();
      }
    });

    test("raw windows see all parents before pagination with nested collections", async () => {
      const rows = await database.authors((author) => ({
        id: author.id,
        total: sql<bigint>`count(*) OVER ()`,
        position: sql<bigint>`row_number() OVER (ORDER BY ${author.id})`,
        posts: author.posts((post) => ({
          id: post.id,
          $orderBy: post.id.ascending,
        })),
        $orderBy: author.id.ascending,
        $limit: 1,
        $offset: 1,
      }));
      expect(rows).toEqual([
        { id: 2, total: 2n, position: 2n, posts: [{ id: 3 }] },
      ]);
    });

    test("raw aggregates summarize the full input alongside scalar subqueries", async () => {
      const posts = database
        .posts((post) => ({
          id: post.id,
          $orderBy: post.id.ascending,
          $limit: 1,
        }))
        .scalar();
      expect(
        await database.authors((author) => ({
          total: sql<bigint>`sum(${author.id})`,
          post: posts,
          $limit: 1,
        })),
      ).toEqual([{ total: 3n, post: 1 }]);
    });

    test("raw windows retain nested pagination semantics", async () => {
      const rows = await database.authors((author) => ({
        id: author.id,
        posts: author.posts((post) => ({
          id: post.id,
          total: sql<number>`(count(*) OVER ())::int`,
          tags: post.tags((tag) => ({ label: tag.label })),
          $orderBy: post.id.ascending,
          $limit: 1,
        })),
        $orderBy: author.id.ascending,
        $limit: 1,
      }));
      expect(rows).toEqual([
        { id: 1, posts: [{ id: 1, total: 2, tags: [{ label: "postgres" }] }] },
      ]);
    });

    test("callback JOINs, computed fields, nested projections and derived tables preserve types and values", async () => {
      const query = database.posts((posts, { leftJoin }) => {
        const author = leftJoin(posts.author);

        return {
          title: posts.title,
          author: { name: author.fullName, visits: author.visits },
          $where: posts.id.is(1),
        };
      });
      expect(await query.one()).toEqual({
        title: "First",
        author: { name: "Ada Lovelace", visits: 9007199254740993n },
      });
      const derived = query.as("article");
      expect(
        await derived((article) => ({ author: article.author })).one(),
      ).toEqual({
        author: { name: "Ada Lovelace", visits: 9007199254740993n },
      });
      expect(
        await database
          .posts((posts, { innerJoin }) => {
            const tags = innerJoin(posts.tags);

            return { label: tags.label };
          })
          .one(),
      ).toEqual({ label: "postgres" });
      expect(
        await database
          .posts((posts) => ({
            id: posts.id,
            state: posts.state,
            title: posts.title,
            createdAt: posts.createdAt,
            metadata: posts.metadata,
            authorId: posts.authorId,
            author: posts.author((author) => ({
              id: author.id,
              visits: author.visits,
              email: author.email,
              firstName: author.firstName,
              lastName: author.lastName,
              fullName: author.fullName,
            })),
            $where: (({ posts }) => posts.id.is(1))({ posts }),
          }))
          .execute(),
      ).toMatchObject([
        { author: { fullName: "Ada Lovelace", visits: 9007199254740993n } },
      ]);
    });

    test("relation counts and existence work for forward, reverse and junction relations", async () => {
      const rows = await database
        .authors((authors) => ({
          name: authors.fullName,
          published: authors
            .posts((posts) => ({ $where: posts.state.is.published }))
            .count(),
          drafts: authors
            .posts((posts) => ({ $where: posts.state.is.draft }))
            .exists(),
          $orderBy: authors.id.ascending,
        }))
        .execute();
      expect(rows).toEqual([
        { name: "Ada Lovelace", published: 1, drafts: true },
        { name: "Grace Hopper", published: 1, drafts: false },
      ]);
      expect(
        await database
          .posts((posts) => ({
            id: posts.id,
            tags: posts.tags.count(),
            author: posts.author.exists(),
            $where: posts.id.in([1, 4]),
            $orderBy: posts.id.ascending,
          }))
          .execute(),
      ).toEqual([
        { id: 1, tags: 1, author: true },
        { id: 4, tags: 0, author: false },
      ]);
    });

    test("smart joins retain unmatched forward, reverse and many-to-many rows", async () => {
      const forward = await database
        .posts((posts, { join }) => {
          const author = join(posts.author);

          return {
            id: posts.id,
            author: author.firstName,
            $orderBy: posts.id.ascending,
          };
        })
        .execute();
      expect(forward).toHaveLength(5);
      expect(forward.at(-1)).toEqual({ id: 5, author: null });
      await database.authors
        .insert({ email: "new", firstName: "New", lastName: "Author" })
        .execute();
      expect(
        await database
          .authors((authors, { join }) => {
            const posts = join(authors.posts);

            return {
              author: authors.firstName,
              title: posts.title,
              $where: authors.email.is("new"),
            };
          })
          .one(),
      ).toEqual({ author: "New", title: null });
      expect(
        await database
          .posts((posts, { join }) => {
            const tags = join(posts.tags);

            return { id: posts.id, tag: tags.label };
          })
          .execute(),
      ).toHaveLength(5);
    });

    test("JSON paths, conditional null narrowing and prepared object selections execute correctly", async () => {
      const lookup = prepare({ theme: text }, (parameters) =>
        database.posts((posts) => ({
          id: posts.id,
          theme: posts.metadata.path("settings", "theme"),
          $where: posts.metadata.path("settings", "theme").is(parameters.theme),
        })),
      );
      expect(await lookup.execute({ theme: "dark" })).toEqual([
        { id: 1, theme: "dark" },
      ]);
      expect(
        await database
          .posts((posts) => ({
            id: posts.id,
            $where: posts.metadata.path("tags").contains(["sql"]),
          }))
          .execute(),
      ).toEqual([{ id: 1 }]);
      expect(
        await database
          .posts((posts) => ({
            theme: posts.metadata.path("settings", "theme").as("theme"),
            $where: posts.id.is(2),
          }))
          .one(),
      ).toEqual({ theme: null });
      const dates = await database
        .posts((posts, { whereNotNull }) => {
          const required0 = whereNotNull(posts.createdAt);

          return { createdAt: required0 };
        })
        .execute();
      expect(dates).toHaveLength(3);
      expect(dates.every((row) => row.createdAt instanceof Date)).toBe(true);
    });

    test("keyset pages handle duplicate sort values, both directions, NULL order and hidden keys", async () => {
      for (const direction of ["ascending", "descending"] as const) {
        for (const nulls of ["nullsFirst", "nullsLast"] as const) {
          const query = database.posts((posts) => ({
            title: posts.title,
            $orderBy: [posts.createdAt[direction][nulls], posts.id.descending],
          }));
          const expected = await query.execute();
          const items: { title: string }[] = [];
          let cursor: PageCursor<{ title: string }> | null = null;
          let pages = 0;
          do {
            const page = await query.page({ size: 2, after: cursor });
            items.push(...page.items);
            cursor = page.nextCursor;
            expect(++pages).toBeLessThan(5);
          } while (cursor);
          expect(items).toEqual(expected);
          expect(pages).toBe(3);
        }
      }

      const query = database.posts((posts) => ({
        id: posts.id,
        $orderBy: posts.id.ascending,
      }));
      const first = await query.page({ size: 2 });
      expect(first.items).toEqual([{ id: 1 }, { id: 2 }]);
      await expect(
        query((posts) => ({ $where: posts.id.above(1) })).page({
          size: 2,
          after: first.nextCursor,
        }),
      ).rejects.toThrow(/another query/);
      await expect(
        database
          .posts((posts) => ({
            id: posts.id,
            $orderBy: posts.createdAt.ascending,
          }))
          .page({ size: 2 }),
      ).rejects.toThrow(/complete primary key/);
      await expect(query.page({ size: 0 })).rejects.toThrow(
        /positive safe integer/,
      );
      await expect(
        query.page({ size: 2, after: "broken" as PageCursor<{ id: number }> }),
      ).rejects.toThrow(/invalid page cursor/);
      await run(
        "UPDATE posts SET created_at = '2026-01-01 00:00:00.000001+00' WHERE id = 1",
      );
      await run(
        "UPDATE posts SET created_at = '2026-01-01 00:00:00.000002+00' WHERE id = 2",
      );
      const precise = database.posts((posts) => ({
        id: posts.id,
        $orderBy: [posts.createdAt.ascending, posts.id.ascending],
      }));
      const preciseFirst = await precise.page({ size: 1 });
      const preciseSecond = await precise.page({
        size: 1,
        after: preciseFirst.nextCursor,
      });
      expect(preciseFirst.items).toEqual([{ id: 1 }]);
      expect(preciseSecond.items).toEqual([{ id: 2 }]);
    });

    test("short upserts return computed projections, one/maybeOne enforce cardinality, rebinding retains transactions", async () => {
      expect(
        await database.authors
          .insert({ email: "ada", firstName: "Augusta", lastName: "King" })
          .onConflict("email")
          .doUpdate("firstName", "lastName")
          .returning((authors) => ({ name: authors.fullName }))
          .execute(),
      ).toEqual({ name: "Augusta King" });
      const missing = database.posts((posts) => ({
        id: posts.id,
        $where: posts.id.is(100),
      }));
      expect(await missing.maybeOne()).toBeNull();
      await expect(missing.one()).rejects.toThrow(/exactly one/);
      await expect(
        database.posts((posts) => ({ id: posts.id })).maybeOne(),
      ).rejects.toThrow(/at most one/);
      const prepared = await database.$transaction(async (transaction) => {
        await transaction.$transaction(async (nested) => {
          expect(
            await nested
              .posts((posts, { innerJoin }) => {
                const author = innerJoin(posts.author);

                return { fullName: author.fullName, $where: posts.id.is(1) };
              })
              .one(),
          ).toEqual({ fullName: "Augusta King" });
        });

        return transaction
          .authors((authors) => ({ fullName: authors.fullName }))
          .prepare();
      });
      await expect(prepared.execute()).rejects.toThrow(/context is closed/);
    });

    test("automatic paths and nested collections execute as one query with per-parent limits", async () => {
      const query = database.authors((authors) => ({
        name: authors.fullName,
        recent: authors.posts((posts) => ({
          title: posts.title,
          visits: posts.author.visits,
          createdAt: posts.createdAt,
          author: posts.author.fullName,
          tags: posts.tags((tags) => ({ label: tags.label })),
          $orderBy: posts.id.descending,
          $limit: 1,
        })),
        tagged: authors.posts((posts) => ({
          title: posts.title,
          $where: posts.tags.some((tags) => tags.label.is("postgres")),
        })),
        $orderBy: authors.id.ascending,
      }));
      expect(await query.execute()).toEqual([
        {
          name: "Ada Lovelace",
          recent: [
            {
              title: "Second",
              visits: 9007199254740993n,
              createdAt: new Date("2026-01-01"),
              author: "Ada Lovelace",
              tags: [],
            },
          ],
          tagged: [{ title: "First" }],
        },
        {
          name: "Grace Hopper",
          recent: [
            {
              title: "Third",
              visits: 9007199254740993n,
              createdAt: new Date("2026-02-01"),
              author: "Grace Hopper",
              tags: [],
            },
          ],
          tagged: [],
        },
      ]);
      expect(
        await database
          .posts((posts) => ({
            tags: posts.tags((tags) => ({
              label: tags.label,
              posts: tags.posts((posts) => ({
                title: posts.title,
                author: posts.author.firstName,
              })),
            })),
            $where: posts.id.is(1),
          }))
          .one(),
      ).toEqual({
        tags: [
          { label: "postgres", posts: [{ title: "First", author: "Ada" }] },
        ],
      });
      expect(
        await database
          .posts((posts) => ({
            author: posts.author((author) => ({ firstName: author.firstName })),
            visits: posts.author.visits,
            tags: posts.tags((tags) => ({ label: tags.label })),
            $where: posts.id.is(4),
          }))
          .one(),
      ).toEqual({ author: null, visits: null, tags: [] });
    });

    test("some/none/every implement empty-set and nullable-predicate semantics", async () => {
      await database.authors
        .insert({ email: "nobody", firstName: "Nobody", lastName: "Here" })
        .execute();
      await database.posts.insert({ title: "Undated", authorId: 1 }).execute();
      const projection = database.authors((authors) => ({
        firstName: authors.firstName,
        $orderBy: authors.id.ascending,
      }));
      expect(
        await projection((authors) => ({
          $where: authors.posts.some((posts) => posts.state.is.draft),
        })).execute(),
      ).toEqual([{ firstName: "Ada" }]);
      expect(
        await projection((authors) => ({
          $where: authors.posts.none((posts) => posts.state.is.published),
        })).execute(),
      ).toEqual([{ firstName: "Nobody" }]);
      expect(
        await projection((authors) => ({
          $where: authors.posts.every((posts) =>
            posts.createdAt.above(new Date("2025-01-01")),
          ),
        })).execute(),
      ).toEqual([{ firstName: "Grace" }, { firstName: "Nobody" }]);
      expect(
        await projection((authors) => ({
          $where: authors.posts.some((posts) =>
            posts.tags.some((tags) =>
              tags.posts.every((posts) => posts.state.is.published),
            ),
          ),
        })).execute(),
      ).toEqual([{ firstName: "Ada" }]);
    });

    test("prepared collection limits, offsets, counts and outer correlations retain their meaning", async () => {
      const query = prepare({ size: int }, (parameters) =>
        database.authors((authors) => ({
          name: authors.firstName,
          posts: authors.posts((posts) => ({
            title: posts.title,
            other: posts.author.posts((other) => ({
              title: other.title,
              $where: other.id.isNot(posts.id),
            })),
            $where: posts.authorId.is(authors.id),
            $orderBy: posts.id.ascending,
            $offset: 1,
            $limit: parameters.size,
          })),
          count: authors
            .posts((posts) => ({
              $orderBy: posts.id.ascending,
              $offset: 1,
              $limit: parameters.size,
            }))
            .count(),
          empty: authors.posts((posts) => ({ $limit: 0 })).exists(),
          $orderBy: authors.id.ascending,
        })),
      );
      expect(await query.execute({ size: 1 })).toEqual([
        {
          name: "Ada",
          posts: [{ title: "Second", other: [{ title: "First" }] }],
          count: 1,
          empty: false,
        },
        { name: "Grace", posts: [], count: 0, empty: false },
      ]);
      expect(
        await database.posts
          .as("articles")((articles) => ({
            name: articles.author.firstName,
            related: articles.author.posts((posts) => ({
              title: posts.title,
              $where: posts.author.firstName.is(articles.author.firstName),
            })),
            $where: articles.id.is(1),
          }))
          .one(),
      ).toEqual({
        name: "Ada",
        related: [{ title: "First" }, { title: "Second" }],
      });
      // The inner path is resolved before the outer path, including across shape calls.
      expect(
        await database
          .posts((posts) => ({
            tags: posts.tags((tags) => ({
              label: tags.label,
              $where: tags.posts.some((related) =>
                related.author.firstName.is(posts.author.firstName),
              ),
            })),
            $where: [posts.id.is(1), posts.author.lastName.is("Lovelace")],
          }))
          .one(),
      ).toEqual({ tags: [{ label: "postgres" }] });
      expect(
        await database.posts
          .as("__symmetria_junction_0")((__symmetria_junction_0) => ({
            tags: __symmetria_junction_0.tags((tags) => ({
              posts: tags.posts((posts) => ({
                title: posts.title,
                $where: posts.id.is(__symmetria_junction_0.id),
              })),
            })),
            $where: __symmetria_junction_0.id.is(1),
          }))
          .one(),
      ).toEqual({ tags: [{ posts: [{ title: "First" }] }] });
    });

    test("custom bigint and numeric codecs stay lossless in nested and derived projections", async () => {
      const storageInteger = customType<string>("bigint", {
        encode: (value) => value.slice(2),
        decode: (value) => `v:${String(value)}`,
      });
      const decimal = customType<string>("numeric(30,10)", {
        encode: (value) => value,
        decode: (value) => String(value),
      });
      const model = schema({
        meters: { id: int },
        readings: ({ meters }) => ({
          id: int,
          meter: meters,
          counter: storageInteger,
          amount: decimal,
        }),
      });

      for (const statement of createSchemaSQL(model.$snapshot())) {
        await driver.execute(statement);
      }

      const connected = createDatabase({ schema: model, driver });
      await connected.meters.insert({ id: 1 }).execute();
      await connected.readings
        .insert({
          id: 1,
          meterId: 1,
          counter: "v:9007199254740993",
          amount: "12345678901234567890.1234567890",
        })
        .execute();
      const expected = {
        counter: "v:9007199254740993",
        amount: "12345678901234567890.1234567890",
      };
      expect(
        await connected
          .meters((meters) => ({
            readings: meters.readings((readings) => ({
              values: { counter: readings.counter, amount: readings.amount },
            })),
          }))
          .one(),
      ).toEqual({ readings: [{ values: expected }] });
      const derived = connected
        .readings((readings) => ({
          counter: readings.counter,
          amount: readings.amount,
        }))
        .as("values");
      expect(
        await derived((values) => ({
          values: { counter: values.counter, amount: values.amount },
        })).one(),
      ).toEqual({ values: expected });
    });

    test("short selections and byId execute with codecs, relation projections and composite keys", async () => {
      expect(
        await database.authors
          .byId(1)((authors) => ({
            fullName: authors.fullName,
            visits: authors.visits,
          }))
          .one(),
      ).toEqual({ fullName: "Ada Lovelace", visits: 9007199254740993n });
      expect(
        await database.posts
          .byId(1)((posts) => ({
            title: posts.title,
            tags: posts.tags((tags) => ({ label: tags.label })),
          }))
          .one(),
      ).toEqual({ title: "First", tags: [{ label: "postgres" }] });
      expect(await database.authors.byId(999).maybeOne()).toBeNull();
      const prepared = prepare({ identifier: int }, (parameters) =>
        database.posts.byId(parameters.identifier)((posts) => ({
          title: posts.title,
        })),
      );
      expect(await prepared.execute({ identifier: 2 })).toEqual([
        { title: "Second" },
      ]);
      expect(
        await database.postTags.byId({ postId: 1, tagId: 1 }).one(),
      ).toEqual({ postId: 1, tagId: 1 });
    });

    test("query inspection uses real PostgreSQL plans and respects transaction lifetime", async () => {
      const query = database.authors.byId(1)((authors) => ({
        name: authors.fullName,
        posts: authors.posts((posts) => ({
          title: posts.title,
          createdAt: posts.createdAt,
          $orderBy: posts.id.ascending,
          $limit: 1,
        })),
      }));
      const compiled = query.toSQL();
      const report = await query.inspect({
        interactive: false,
        execute: true,
        explain: true,
      });
      expect(report.sql).toBe(compiled.sql);
      expect(report.parameters).toEqual(compiled.parameters);
      expect(report.results?.rows).toEqual([
        {
          name: "Ada Lovelace",
          posts: [{ title: "First", createdAt: new Date("2026-01-01") }],
        },
      ]);
      expect(report.explanation?.plan[0]).toHaveProperty("Plan");
      expect(report.explanation?.analyzed).toBe(false);
      const analyzed = await query.inspect({
        interactive: false,
        explain: "analyze",
      });
      expect(analyzed.explanation?.plan[0]).toHaveProperty("Execution Time");
      expect(analyzed.explanation?.analyzed).toBe(true);
      expect(query.toSQL()).toEqual(compiled);
      let expired!: () => Promise<unknown>;
      await database.$transaction(async (transaction) => {
        const current = transaction.authors.byId(1)((authors) => ({
          firstName: authors.firstName,
        }));
        expect(
          (await current.inspect({ interactive: false, execute: true })).results
            ?.rows,
        ).toEqual([{ firstName: "Ada" }]);
        expired = () => current.inspect({ interactive: false, explain: true });
      });
      await expect(expired()).rejects.toThrow(/context is closed/);
    });

    test("self relations and reverse one-to-one paths preserve absent rows", async () => {
      const model = schema({
        treeNodes: ({ treeNodes }) => ({
          id: int,
          title: text,
          parent: treeNodes.nullable.inverse("children"),
        }),
        nodeDetails: ({ treeNodes }) => ({
          id: int,
          node: treeNodes.unique,
          description: text,
        }),
      });

      for (const statement of createSchemaSQL(model.$snapshot())) {
        await driver.execute(statement);
      }

      const connected = createDatabase({ schema: model, driver });
      await connected.treeNodes
        .insert([
          { id: 1, title: "Root", parentId: null },
          { id: 2, title: "Child", parentId: 1 },
          { id: 3, title: "Leaf", parentId: 2 },
        ])
        .execute();
      await connected.nodeDetails
        .insert({ id: 1, nodeId: 1, description: "Root details" })
        .execute();
      expect(
        await connected
          .treeNodes((treeNodes) => ({
            title: treeNodes.title,
            ancestor: treeNodes.parent.parent.title,
            description: treeNodes.nodeDetails.description,
            children: treeNodes.children((children) => ({
              title: children.title,
              parent: children.parent.title,
            })),
            $orderBy: treeNodes.id.ascending,
          }))
          .execute(),
      ).toEqual([
        {
          title: "Root",
          ancestor: null,
          description: "Root details",
          children: [{ title: "Child", parent: "Root" }],
        },
        {
          title: "Child",
          ancestor: null,
          description: null,
          children: [{ title: "Leaf", parent: "Child" }],
        },
        { title: "Leaf", ancestor: "Root", description: null, children: [] },
      ]);
    });
  },
);
