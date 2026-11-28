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
  smallint,
  text,
  bigint,
  numeric,
  real,
  doublePrecision,
  bool,
  uuid,
  jsonb,
  date,
  time,
  interval,
  timestamp,
  timestamptz,
  oneOf,
  sql,
  dateTrunc,
  prepare,
  customType,
  type Page,
  type PageCursor,
  type PageOptions,
} from "../../../packages/runtime/src";
import {
  postgres,
  searchPathURL,
  testDatabase,
  transactionPooling,
} from "../../support/postgres";
import { createSchemaSQL } from "../../../packages/kit/src";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "modular schema and query conveniences on PostgreSQL",
  () => {
    const namespace = `symmetria_magic_${crypto.randomUUID().replaceAll("-", "")}`;
    const driver = postgres({ url: searchPathURL(namespace), max: 1 });
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
      const rows = await database.authors(
        (author) => ({
          id: author.id,
          total: sql<bigint>`count(*) OVER ()`,
          position: sql<bigint>`row_number() OVER (ORDER BY ${author.id})`,
          posts: author.posts(
            (post) => ({
              id: post.id,
            }),
            { orderBy: (post) => post.id.ascending },
          ),
        }),
        { orderBy: (author) => author.id.ascending, limit: 1, offset: 1 },
      );
      expect(rows).toEqual([
        { id: 2, total: 2n, position: 2n, posts: [{ id: 3 }] },
      ]);
    });

    test("raw aggregates summarize the full input alongside scalar subqueries", async () => {
      const posts = database
        .posts(
          (post) => ({
            id: post.id,
          }),
          { orderBy: (post) => post.id.ascending, limit: 1 },
        )
        .scalar();
      expect(
        await database.authors(
          (author) => ({
            total: sql<bigint>`sum(${author.id})`,
            post: posts,
          }),
          { limit: 1 },
        ),
      ).toEqual([{ total: 3n, post: 1 }]);
    });

    test("raw windows retain nested pagination semantics", async () => {
      const rows = await database.authors(
        (author) => ({
          id: author.id,
          posts: author.posts(
            (post) => ({
              id: post.id,
              total: sql<number>`(count(*) OVER ())::int`,
              tags: post.tags((tag) => ({ label: tag.label })),
            }),
            { orderBy: (post) => post.id.ascending, limit: 1 },
          ),
        }),
        { orderBy: (author) => author.id.ascending, limit: 1 },
      );
      expect(rows).toEqual([
        { id: 1, posts: [{ id: 1, total: 2, tags: [{ label: "postgres" }] }] },
      ]);
    });

    test("callback JOINs, computed fields, nested projections and derived tables preserve types and values", async () => {
      const query = database.posts(
        (posts, { leftJoin }) => {
          const author = leftJoin(posts.author);

          return {
            title: posts.title,
            author: { name: author.fullName, visits: author.visits },
          };
        },
        { where: (posts, { leftJoin }) => posts.id.is(1) },
      );
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
          .posts(
            (posts) => ({
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
            }),
            { where: (posts) => (({ posts }) => posts.id.is(1))({ posts }) },
          )
          .execute(),
      ).toMatchObject([
        { author: { fullName: "Ada Lovelace", visits: 9007199254740993n } },
      ]);
    });

    test("relation counts and existence work for forward, reverse and junction relations", async () => {
      const rows = await database
        .authors(
          (authors) => ({
            name: authors.fullName,
            published: authors
              .posts({ where: (posts) => posts.state.is.published })
              .count(),
            drafts: authors
              .posts({ where: (posts) => posts.state.is.draft })
              .exists(),
          }),
          { orderBy: (authors) => authors.id.ascending },
        )
        .execute();
      expect(rows).toEqual([
        { name: "Ada Lovelace", published: 1, drafts: true },
        { name: "Grace Hopper", published: 1, drafts: false },
      ]);
      expect(
        await database
          .posts(
            (posts) => ({
              id: posts.id,
              tags: posts.tags.count(),
              author: posts.author.exists(),
            }),
            {
              where: (posts) => posts.id.in([1, 4]),
              orderBy: (posts) => posts.id.ascending,
            },
          )
          .execute(),
      ).toEqual([
        { id: 1, tags: 1, author: true },
        { id: 4, tags: 0, author: false },
      ]);
    });

    test("smart joins retain unmatched forward, reverse and many-to-many rows", async () => {
      const forward = await database
        .posts(
          (posts, { join }) => {
            const author = join(posts.author);

            return {
              id: posts.id,
              author: author.firstName,
            };
          },
          { orderBy: (posts, { join }) => posts.id.ascending },
        )
        .execute();
      expect(forward).toHaveLength(5);
      expect(forward.at(-1)).toEqual({ id: 5, author: null });
      await database.authors
        .insert({ email: "new", firstName: "New", lastName: "Author" })
        .execute();
      expect(
        await database
          .authors(
            (authors, { join }) => {
              const posts = join(authors.posts);

              return {
                author: authors.firstName,
                title: posts.title,
              };
            },
            { where: (authors, { join }) => authors.email.is("new") },
          )
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
        database.posts(
          (posts) => ({
            id: posts.id,
            theme: posts.metadata.path("settings", "theme"),
          }),
          {
            where: (posts) =>
              posts.metadata.path("settings", "theme").is(parameters.theme),
          },
        ),
      );
      expect(await lookup.execute({ theme: "dark" })).toEqual([
        { id: 1, theme: "dark" },
      ]);
      expect(
        await database
          .posts(
            (posts) => ({
              id: posts.id,
            }),
            { where: (posts) => posts.metadata.path("tags").contains(["sql"]) },
          )
          .execute(),
      ).toEqual([{ id: 1 }]);
      expect(
        await database
          .posts(
            (posts) => ({
              theme: posts.metadata.path("settings", "theme").as("theme"),
            }),
            { where: (posts) => posts.id.is(2) },
          )
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
          const query = database.posts(
            (posts) => ({
              title: posts.title,
            }),
            {
              orderBy: (posts) => [
                posts.createdAt[direction][nulls],
                posts.id.descending,
              ],
            },
          );
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

      const query = database.posts(
        (posts) => ({
          id: posts.id,
        }),
        { orderBy: (posts) => posts.id.ascending },
      );
      const first = await query.page({ size: 2 });
      expect(first.items).toEqual([{ id: 1 }, { id: 2 }]);
      await expect(
        query({ where: (posts) => posts.id.above(1) }).page({
          size: 2,
          after: first.nextCursor,
        }),
      ).rejects.toThrow(/another query/);
      await expect(
        database
          .posts(
            (posts) => ({
              id: posts.id,
            }),
            { orderBy: (posts) => posts.createdAt.ascending },
          )
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
      const precise = database.posts(
        (posts) => ({
          id: posts.id,
        }),
        { orderBy: (posts) => [posts.createdAt.ascending, posts.id.ascending] },
      );
      const preciseFirst = await precise.page({ size: 1 });
      const preciseSecond = await precise.page({
        size: 1,
        after: preciseFirst.nextCursor,
      });
      expect(preciseFirst.items).toEqual([{ id: 1 }]);
      expect(preciseSecond.items).toEqual([{ id: 2 }]);
    });

    test("cursors distinguish filters on NaN and signed infinities", async () => {
      const fixture = await testDatabase({
        url: databaseUrl!,
        schema: schema({ samples: { id: int.auto, value: doublePrecision } }),
      });
      try {
        const samples = fixture.database.samples;
        const values = [NaN, Infinity, -Infinity];
        await samples.insert(
          [...values, ...values].map((value) => ({ value })),
        );
        const query = (value: number) =>
          samples((r) => ({ id: r.id }), {
            where: (r) => r.value.is(value),
            orderBy: (r) => r.id.asc,
          });
        for (const [i, value] of values.entries()) {
          const { nextCursor } = await query(value).page({ size: 1 });
          expect(
            (await query(value).page({ size: 1, after: nextCursor })).items,
          ).toEqual([{ id: i + 4 }]);
          for (const other of values.filter((v) => !Object.is(v, value))) {
            await expect(
              query(other).page({ size: 1, after: nextCursor }),
            ).rejects.toThrow(/another query/);
          }
        }
      } finally {
        await fixture.close();
      }
    });

    test("cursors round-trip long text and preserve array bounds used to break ties", async () => {
      const fixture = await testDatabase({
        url: databaseUrl!,
        schema: schema({
          entries: { id: int.auto, label: text, nums: int.array },
        }),
      });
      try {
        await fixture.driver.execute({
          sql: `INSERT INTO entries (label, nums) VALUES
            (repeat('z', 50000), '{1,2}'),
            (repeat('a', 50000), '[0:1]={1,2}')`,
          parameters: [],
        });
        for (const key of ["label", "nums"] as const) {
          const query = fixture.database.entries((r) => ({ id: r.id }), {
            orderBy: (r) => [r[key].ascending, r.id.ascending],
          });
          const first = await query.page({ size: 1 });
          expect(first.items).toEqual([{ id: 2 }]);
          const second = await query.page({ size: 1, after: first.nextCursor });
          expect(second.items).toEqual([{ id: 1 }]);
          expect(second.nextCursor).toBeNull();
          expect(
            (await query.page({ size: 1, before: second.previousCursor }))
              .items,
          ).toEqual(first.items);
        }
      } finally {
        await fixture.close();
      }
    });

    test("a page with a row lock locks its rows and the row read ahead, whatever the projection holds", async () => {
      const jobs = table({
        id: int.auto,
        name: text,
        createdAt: timestamptz.now,
      }).computed((job) => ({ upper: sql<string>`upper(${job.name})` }));
      const fixture = await testDatabase({
        url: databaseUrl!,
        schema: schema({ jobs }),
      });
      try {
        const db = fixture.database;
        type Session = Pick<typeof db, "jobs">;
        const ids = Array.from({ length: 12 }, (_, index) => index + 1);
        await db.jobs.insert(ids.map((id) => ({ name: `job ${id}` })));
        // From another connection: the rows it can no longer lock.
        const locked = async () => {
          const free = await db.jobs((job) => ({ id: job.id }), {
            forUpdate: { skipLocked: true },
          });
          return ids.filter((id) => !free.some((row) => row.id === id));
        };
        const check = async <Row extends { id: number }>(
          read: (session: Session) => {
            page: (options: PageOptions<Row>) => Promise<Page<Row>>;
          },
        ) => {
          // Three pages of two rows, each in a transaction of its own.
          const first = await db.$transaction((tx) =>
            read(tx).page({ size: 2 }),
          );
          const second = await db.$transaction(async (tx) => {
            const page = await read(tx).page({
              size: 2,
              after: first.nextCursor,
            });
            expect(await locked()).toEqual([3, 4, 5]);
            return page;
          });
          const third = await db.$transaction((tx) =>
            read(tx).page({ size: 2, after: second.nextCursor }),
          );
          expect(second.items.map((row) => row.id)).toEqual([3, 4]);
          // Backward from job 5: jobs 4 and 3, and job 2 read ahead.
          await db.$transaction(async (tx) => {
            const page = await read(tx).page({
              size: 2,
              before: third.previousCursor,
            });
            expect(page.items.map((row) => row.id)).toEqual([3, 4]);
            expect(await locked()).toEqual([2, 3, 4]);
          });
          expect(await locked()).toEqual([]);
        };

        for (const forUpdate of [true, { of: ["jobs"] }] as const) {
          await check((session) =>
            session.jobs((job) => ({ id: job.id, name: job.name }), {
              orderBy: (job) => job.id.asc,
              forUpdate,
            }),
          );
          await check((session) =>
            session.jobs(
              (job) => ({ id: job.id, day: dateTrunc("day", job.createdAt) }),
              { orderBy: (job) => job.id.asc, forUpdate },
            ),
          );
          await check((session) =>
            session.jobs(
              (job) => ({
                id: job.id,
                upper: sql<string>`upper(${job.name})`,
              }),
              { orderBy: (job) => job.id.asc, forUpdate },
            ),
          );
          await check((session) =>
            session.jobs((job) => ({ id: job.id, upper: job.upper }), {
              orderBy: (job) => job.id.asc,
              forUpdate,
            }),
          );
          // The whole row holds the computed field.
          await check((session) =>
            session.jobs({ orderBy: (job) => job.id.asc, forUpdate }),
          );
          // A window function cannot be locked: PostgreSQL says so itself.
          await expect(
            db.$transaction((tx) =>
              tx
                .jobs(
                  (job, { rowNumber }) => ({
                    id: job.id,
                    position: rowNumber().over({ orderBy: job.id.asc }),
                  }),
                  { orderBy: (job) => job.id.asc, forUpdate },
                )
                .page({ size: 2 }),
            ),
          ).rejects.toThrow(/FOR UPDATE is not allowed with window functions/);
        }

        await check((session) =>
          session.jobs(
            (job) => ({ id: job.id, day: dateTrunc("day", job.createdAt) }),
            { orderBy: (job) => job.id.asc, forShare: true },
          ),
        );
      } finally {
        await fixture.close();
      }
    });

    test.skipIf(transactionPooling)(
      "pages walk both ways over the edge values of every ordering type",
      async () => {
        const edges = table({
          id: int.auto,
          small: smallint,
          whole: int,
          big: bigint,
          exact: numeric,
          single: real,
          double: doublePrecision,
          day: date,
          moment: timestamp,
          instant: timestamptz,
          clock: time,
          zoned: customType<string>("timetz", {
            encode: (value) => value,
            decode: String,
          }),
          span: interval,
          state: oneOf("draft", "published", "archived"),
          label: text,
          flag: bool,
          key: uuid,
        });
        // One connection, so the session settings below hold for every page.
        const fixture = await testDatabase({
          url: databaseUrl!,
          schema: schema({ edges }),
          max: 1,
        });
        const run = (statement: string) =>
          fixture.driver.execute({ sql: statement, parameters: [] });
        try {
          // The widest intervals PostgreSQL 14 still reads: later versions
          // take hours up to 2562047788.
          await run(`INSERT INTO edges
            (small, whole, big, exact, single, double, day, moment, instant, clock, zoned, span, state, label, flag, key)
            VALUES
            (-32768, -2147483648, -9223372036854775808, 'NaN', 'NaN', 'NaN', '-infinity', '-infinity', '-infinity',
              '00:00:00', '00:00:00+15:59:59', '-178956970 years -8 mons -2147483648 days -2147483647:59:59.999999',
              'draft', '', false, '00000000-0000-0000-0000-000000000000'),
            (32767, 2147483647, 9223372036854775807, '1e400', 'Infinity', 'Infinity', 'infinity', 'infinity', 'infinity',
              '24:00:00', '24:00:00-15:59:59', '178956970 years 7 mons 2147483647 days 2147483647:59:59.999999',
              'archived', 'ééé', true, 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
            (0, 0, 0, '-1e400', '-Infinity', '-Infinity', '4714-11-24 BC', '4714-11-24 00:00:00 BC', '4714-11-24 00:00:00+00 BC',
              '23:59:59.999999', '23:59:59.999999+05:30', '00:00:00',
              'published', 'a', true, '00000000-0000-0000-0000-000000000001'),
            (-1, -1, -1, '1e-400', '3.4028235e38', '1.7976931348623157e308', '5874897-12-31', '294276-12-31 23:59:59.999999', '294276-12-31 23:59:59.999999+00',
              '12:34:56.7', '12:34:56.7-04:56:02', '1 year 2 mons -3 days +04:05:06.789',
              'draft', 'b', false, '00000000-0000-0000-0000-000000000002'),
            (1, 1, 1, '-0.50', '1e-45', '4.9e-324', '0001-02-29 BC', '0001-12-31 23:59:59.999999 BC', '0001-01-01 00:00:00+00',
              '00:00:00.000001', '00:00:00.000001+00', '-1 mon +1 day -00:00:00.000001',
              'published', 'c', true, '00000000-0000-0000-0000-000000000003'),
            (2, 2, 2, '123456789012345678901234567890.123456789', '-0', '-0', '10000-01-01', '10000-01-01 00:00:00', '1800-01-01 00:00:00+00',
              '23:59:60', '23:59:60+00', '-00:00:00.5',
              'archived', 'd', false, '00000000-0000-0000-0000-000000000004'),
            (3, 3, 3, '0', '16777216', '1e15', '2024-02-29', '2024-02-29 12:34:56.789', '0044-03-15 12:00:00+00 BC',
              '01:02:03', '01:02:03-12', '11 mons 59 days 59:59:59.999999',
              'draft', 'e', true, '00000000-0000-0000-0000-000000000005')`);
          const keys = [
            "small",
            "whole",
            "big",
            "exact",
            "single",
            "double",
            "day",
            "moment",
            "instant",
            "clock",
            "zoned",
            "span",
            "state",
            "label",
            "flag",
            "key",
          ] as const;

          // Zones on both sides of UTC (one with an offset in seconds for old
          // dates) and each form PostgreSQL prints an interval in.
          for (const [zone, style] of [
            ["America/New_York", "postgres"],
            ["Pacific/Kiritimati", "postgres_verbose"],
            ["Etc/GMT+12", "sql_standard"],
            ["Asia/Manila", "iso_8601"],
          ]) {
            await run(`SET TimeZone TO '${zone}'`);
            await run(`SET IntervalStyle TO ${style}`);

            for (const key of keys) {
              const query = fixture.database.edges((row) => ({ id: row.id }), {
                orderBy: (row) => [row[key].asc, row.id.asc],
              });
              const expected = await query;
              const forward: { id: number }[] = [];
              let page = await query.page({ size: 2 });
              forward.push(...page.items);

              while (page.nextCursor) {
                page = await query.page({ size: 2, after: page.nextCursor });
                forward.push(...page.items);
              }

              expect(forward).toEqual(expected);

              const backward = [...page.items];

              while (page.previousCursor) {
                page = await query.page({
                  size: 2,
                  before: page.previousCursor,
                });
                backward.unshift(...page.items);
              }

              expect(backward).toEqual(expected);
            }

            // The settings were in force up to the last page.
            const session = await run(
              "SELECT current_setting('TimeZone') AS zone, current_setting('IntervalStyle') AS style",
            );
            expect(Array.isArray(session) ? session : session.rows).toEqual([
              { zone, style },
            ]);
          }
        } finally {
          await fixture.close();
        }
      },
    );

    test("a cursor whose values PostgreSQL could not read is an invalid cursor, and a data error stays a database error", async () => {
      const fixture = await testDatabase({
        url: databaseUrl!,
        schema: schema({
          entries: {
            id: int.auto,
            small: smallint.default(1),
            big: bigint.default(1n),
            price: numeric(5, 2).default("1.00"),
            ratio: real.default(1),
            score: doublePrecision.default(1),
            day: date.default("2024-01-01"),
            moment: timestamp.now,
            instant: timestamptz.now,
            clock: time.default("10:00:00"),
            span: interval.default("1 day"),
            state: oneOf("draft", "published").default("draft"),
            label: text.default("x"),
          },
        }),
      });
      try {
        const entries = fixture.database.entries;
        await entries.insert(
          Array.from({ length: 4 }, (_, index) => ({
            label: `entry ${index}`,
          })),
        );
        const forged = [
          ["id", "9999999999999999999"],
          ["small", "9223372036854775808"],
          ["big", "9999999999999999999"],
          ["price", "1e400000"],
          ["ratio", "1e309"],
          ["score", "1e309"],
          ["day", "2024-02-31"],
          ["day", "0000-01-01"],
          ["instant", "2024-01-01 00:00:00+99"],
          ["instant", "2023-02-29 00:00:00+00"],
          ["clock", "25:99"],
          ["span", "garbage"],
          ["span", "2147483648 days"],
          ["label", "a\u0000b"],
        ] as const;

        for (const [key, value] of forged) {
          const query = entries((row) => ({ id: row.id }), {
            orderBy: (row) =>
              key === "id" ? [row.id.asc] : [row[key].asc, row.id.asc],
          });
          const { nextCursor } = await query.page({ size: 2 });
          const issued = JSON.parse(
            Buffer.from(nextCursor!, "base64url").toString(),
          );
          const cursor = Buffer.from(
            JSON.stringify({
              ...issued,
              values: key === "id" ? [value] : [value, "1"],
            }),
          ).toString("base64url") as NonNullable<typeof nextCursor>;

          expect(
            await query.page({ size: 2, after: cursor }).then(
              () => `${key} ${value}: accepted`,
              (error) => `${key}: ${error.message}`,
            ),
          ).toBe(
            `${key}: symmetria: invalid page cursor or cursor from another query`,
          );
          // The cursor the query issued itself still continues it.
          expect(
            (await query.page({ size: 2, after: nextCursor })).items,
          ).toEqual([{ id: 3 }, { id: 4 }]);
        }

        // A value PostgreSQL cannot read in a later row is not the cursor's fault.
        const numbered = entries(
          (row) => ({ id: row.id, number: sql.of(int)`${row.label}::integer` }),
          { orderBy: (row) => row.id.asc },
        );
        await entries.update({ label: "7" }).all();
        const { nextCursor } = await numbered.page({ size: 2 });
        await entries.update(
          { label: "seven" },
          { where: (row) => row.id.is(4) },
        );
        await expect(
          numbered.page({ size: 2, after: nextCursor }),
        ).rejects.toThrow(/invalid input syntax for type integer/);

        // A column the database already holds wider than this schema declares
        // (a migration applied before the new code runs) pages as before.
        await fixture.driver.execute({
          sql: "ALTER TABLE entries ALTER COLUMN small TYPE bigint, ALTER COLUMN ratio TYPE double precision",
          parameters: [],
        });
        await fixture.driver.execute({
          sql: "UPDATE entries SET small = 3000000000 + id, ratio = 1e300 * id",
          parameters: [],
        });

        for (const key of ["small", "ratio"] as const) {
          const widened = entries((row) => ({ id: row.id }), {
            orderBy: (row) => [row[key].asc, row.id.asc],
          });
          const first = await widened.page({ size: 2 });
          const rest = await widened.page({ size: 5, after: first.nextCursor });
          const back = await widened.page({
            size: 5,
            before: rest.nextCursor ?? rest.previousCursor,
          });

          expect([...first.items, ...rest.items]).toEqual([
            { id: 1 },
            { id: 2 },
            { id: 3 },
            { id: 4 },
          ]);
          expect(back.items.length).toBeGreaterThan(0);
        }

        // A label the database got from a newer migration than this schema
        // is a value like any other: the page ordered by it keeps its cursor.
        await fixture.driver.execute({
          sql: "ALTER TYPE entries_state_enum ADD VALUE 'archived'",
          parameters: [],
        });
        await fixture.driver.execute({
          sql: "UPDATE entries SET state = 'archived' WHERE id IN (2, 3)",
          parameters: [],
        });
        const byState = entries((row) => ({ id: row.id }), {
          orderBy: (row) => [row.state.desc, row.id.asc],
        });
        const first = await byState.page({ size: 1 });
        const second = await byState.page({ size: 5, after: first.nextCursor });

        expect([...first.items, ...second.items]).toEqual([
          { id: 2 },
          { id: 3 },
          { id: 1 },
          { id: 4 },
        ]);
      } finally {
        await fixture.close();
      }
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
      const missing = database.posts(
        (posts) => ({
          id: posts.id,
        }),
        { where: (posts) => posts.id.is(100) },
      );
      expect(await missing.maybeOne()).toBeNull();
      await expect(missing.one()).rejects.toThrow(/exactly one/);
      await expect(
        database.posts((posts) => ({ id: posts.id })).maybeOne(),
      ).rejects.toThrow(/at most one/);
      const prepared = await database.$transaction(async (transaction) => {
        await transaction.$transaction(async (nested) => {
          expect(
            await nested
              .posts(
                (posts, { innerJoin }) => {
                  const author = innerJoin(posts.author);

                  return { fullName: author.fullName };
                },
                { where: (posts, { innerJoin }) => posts.id.is(1) },
              )
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
      const query = database.authors(
        (authors) => ({
          name: authors.fullName,
          recent: authors.posts(
            (posts) => ({
              title: posts.title,
              visits: posts.author.visits,
              createdAt: posts.createdAt,
              author: posts.author.fullName,
              tags: posts.tags((tags) => ({ label: tags.label })),
            }),
            { orderBy: (posts) => posts.id.descending, limit: 1 },
          ),
          tagged: authors.posts(
            (posts) => ({
              title: posts.title,
            }),
            {
              where: (posts) =>
                posts.tags.some((tags) => tags.label.is("postgres")),
            },
          ),
        }),
        { orderBy: (authors) => authors.id.ascending },
      );
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
          .posts(
            (posts) => ({
              tags: posts.tags((tags) => ({
                label: tags.label,
                posts: tags.posts((posts) => ({
                  title: posts.title,
                  author: posts.author.firstName,
                })),
              })),
            }),
            { where: (posts) => posts.id.is(1) },
          )
          .one(),
      ).toEqual({
        tags: [
          { label: "postgres", posts: [{ title: "First", author: "Ada" }] },
        ],
      });
      expect(
        await database
          .posts(
            (posts) => ({
              author: posts.author((author) => ({
                firstName: author.firstName,
              })),
              visits: posts.author.visits,
              tags: posts.tags((tags) => ({ label: tags.label })),
            }),
            { where: (posts) => posts.id.is(4) },
          )
          .one(),
      ).toEqual({ author: null, visits: null, tags: [] });
    });

    test("some/none/every implement empty-set and nullable-predicate semantics", async () => {
      await database.authors
        .insert({ email: "nobody", firstName: "Nobody", lastName: "Here" })
        .execute();
      await database.posts.insert({ title: "Undated", authorId: 1 }).execute();
      const projection = database.authors(
        (authors) => ({
          firstName: authors.firstName,
        }),
        { orderBy: (authors) => authors.id.ascending },
      );
      expect(
        await projection({
          where: (authors) =>
            authors.posts.some((posts) => posts.state.is.draft),
        }).execute(),
      ).toEqual([{ firstName: "Ada" }]);
      expect(
        await projection({
          where: (authors) =>
            authors.posts.none((posts) => posts.state.is.published),
        }).execute(),
      ).toEqual([{ firstName: "Nobody" }]);
      expect(
        await projection({
          where: (authors) =>
            authors.posts.every((posts) =>
              posts.createdAt.above(new Date("2025-01-01")),
            ),
        }).execute(),
      ).toEqual([{ firstName: "Grace" }, { firstName: "Nobody" }]);
      expect(
        await projection({
          where: (authors) =>
            authors.posts.some((posts) =>
              posts.tags.some((tags) =>
                tags.posts.every((posts) => posts.state.is.published),
              ),
            ),
        }).execute(),
      ).toEqual([{ firstName: "Ada" }]);
    });

    test("prepared collection limits, offsets, counts and outer correlations retain their meaning", async () => {
      const query = prepare({ size: int }, (parameters) =>
        database.authors(
          (authors) => ({
            name: authors.firstName,
            posts: authors.posts(
              (posts) => ({
                title: posts.title,
                other: posts.author.posts(
                  (other) => ({
                    title: other.title,
                  }),
                  { where: (other) => other.id.isNot(posts.id) },
                ),
              }),
              {
                where: (posts) => posts.authorId.is(authors.id),
                orderBy: (posts) => posts.id.ascending,
                offset: 1,
                limit: parameters.size,
              },
            ),
            count: authors
              .posts({
                orderBy: (posts) => posts.id.ascending,
                offset: 1,
                limit: parameters.size,
              })
              .count(),
            empty: authors.posts({ limit: 0 }).exists(),
          }),
          { orderBy: (authors) => authors.id.ascending },
        ),
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
          .as("articles")(
            (articles) => ({
              name: articles.author.firstName,
              related: articles.author.posts(
                (posts) => ({
                  title: posts.title,
                }),
                {
                  where: (posts) =>
                    posts.author.firstName.is(articles.author.firstName),
                },
              ),
            }),
            { where: (articles) => articles.id.is(1) },
          )
          .one(),
      ).toEqual({
        name: "Ada",
        related: [{ title: "First" }, { title: "Second" }],
      });
      // The inner path is resolved before the outer path, including across shape calls.
      expect(
        await database
          .posts(
            (posts) => ({
              tags: posts.tags(
                (tags) => ({
                  label: tags.label,
                }),
                {
                  where: (tags) =>
                    tags.posts.some((related) =>
                      related.author.firstName.is(posts.author.firstName),
                    ),
                },
              ),
            }),
            {
              where: (posts) => [
                posts.id.is(1),
                posts.author.lastName.is("Lovelace"),
              ],
            },
          )
          .one(),
      ).toEqual({ tags: [{ label: "postgres" }] });
      expect(
        await database.posts
          .as("__symmetria_junction_0")(
            (__symmetria_junction_0) => ({
              tags: __symmetria_junction_0.tags((tags) => ({
                posts: tags.posts(
                  (posts) => ({
                    title: posts.title,
                  }),
                  { where: (posts) => posts.id.is(__symmetria_junction_0.id) },
                ),
              })),
            }),
            {
              where: (__symmetria_junction_0) =>
                __symmetria_junction_0.id.is(1),
            },
          )
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
        posts: authors.posts(
          (posts) => ({
            title: posts.title,
            createdAt: posts.createdAt,
          }),
          { orderBy: (posts) => posts.id.ascending, limit: 1 },
        ),
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
          .treeNodes(
            (treeNodes) => ({
              title: treeNodes.title,
              ancestor: treeNodes.parent.parent.title,
              description: treeNodes.nodeDetails.description,
              children: treeNodes.children((children) => ({
                title: children.title,
                parent: children.parent.title,
              })),
            }),
            { orderBy: (treeNodes) => treeNodes.id.ascending },
          )
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
