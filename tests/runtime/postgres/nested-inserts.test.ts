import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
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
  bytea,
  numeric,
  timestamptz,
  doublePrecision,
  index,
  sql,
  customType,
  createProfiler,
  one,
  maybe,
  many,
  self,
} from "../../../packages/runtime/src";
import {
  bun,
  postgres,
  searchPathURL,
  testDatabase,
  transactionPooling,
} from "../../support/postgres";
import { testDatabase as isolatedDatabase } from "../../../packages/kit/src/testing";
import { createSchemaSQL } from "../../../packages/kit/src";

const users = table({
  id: int.auto,
  email: text.unique,
  name: text,
  visits: bigint.default(9007199254740993n),
  createdAt: timestamptz.now,
});
const posts = table({
  id: int.auto,
  author: users,
  slug: text.unique,
  title: text,
});
const tags = table({ id: int.auto, label: text.unique }).checks((tags) => ({
  valid: tags.label.isNot("rejected"),
}));
const postTags = junction({ post: posts, tag: tags });
const handles = table({
  id: int.auto,
  tenant: text,
  handle: text,
  active: int,
}).indexes((handles) => ({
  identity: index(handles.tenant, handles.handle).unique,
  partial: index(handles.handle).unique.where(handles.active.is(1)),
  expression: index(sql<string>`lower(${handles.handle})`).unique,
}));
const amount = customType<{ cents: () => bigint }>("numeric(30, 0)", {
  encode: (value) => value.cents().toString(),
  decode: (value) => ({ cents: () => BigInt(String(value)) }),
});
const wallets = table({ id: int.auto, owner: users, amount: amount.unique });
const model = schema({ users, posts, tags, postTags, handles, wallets });
const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("atomic nested inserts on PostgreSQL", () => {
  const namespace = `symmetria_nested_${crypto.randomUUID().replaceAll("-", "")}`;
  const driver = postgres({ url: searchPathURL(namespace), max: 1 });
  const database = createDatabase({ schema: model, driver });

  const profiler = createProfiler();
  const profiled = createDatabase({
    schema: model,
    driver: profiler.driver(driver),
  });

  const run = (statement: string) =>
    driver.execute({ sql: statement, parameters: [] });

  /** The statements one operation sent, as the profiler recorded them. */
  const statements = async (
    operation: () => PromiseLike<unknown>,
  ): Promise<string[]> => {
    await profiler.trace("nested insert", async () => {
      await operation();
    });

    // Requests are kept in the order they finished.
    return profiler
      .snapshot()
      .at(-1)!
      .queries.map((query) => query.sql.split("\n")[0]!);
  };

  beforeAll(async () => {
    await run(`CREATE SCHEMA "${namespace}"`);

    for (const statement of createSchemaSQL(model.$snapshot())) {
      await driver.execute(statement);
    }
  });

  beforeEach(async () => {
    await run(
      "TRUNCATE users, posts, tags, post_tags, handles, wallets RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    try {
      await run(`DROP SCHEMA "${namespace}" CASCADE`);
    } finally {
      await driver.close();
    }
  });

  test("creates forward and junction rows, preserves exact returning types and reuses unique targets", async () => {
    const query = database.posts
      .insert({
        slug: "first",
        title: "First",
        author: { create: { email: "ada", name: "Ada" } },
        tags: { connectOrCreate: [{ label: "bun" }, { label: "postgres" }] },
      })
      .returning((posts) => ({
        id: posts.id,
        title: posts.title,
        authorId: posts.authorId,
      }));
    const post = await query.execute();
    expectTypeOf(post).toEqualTypeOf<{
      id: number;
      title: string;
      authorId: number;
    }>();
    expect(post).toEqual({ id: 1, title: "First", authorId: 1 });
    await database.posts
      .insert({
        slug: "second",
        title: "Second",
        author: { connect: { email: "ada" } },
        tags: { connectOrCreate: [{ label: "bun" }] },
      })
      .execute();
    expect(
      await database.tags((tags) => ({ label: tags.label })).execute(),
    ).toHaveLength(2);
    expect(
      await database
        .postTags((postTags) => ({
          postId: postTags.postId,
          tagId: postTags.tagId,
        }))
        .execute(),
    ).toHaveLength(3);
    const user = await database.users.by.email("ada").one();
    expect(user.visits).toBe(9007199254740993n);
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  test("bulk INSERT above the wire-protocol parameter limit runs as atomic chunks", async () => {
    const rows = Array.from({ length: 22_000 }, (_, n) => ({
      email: `bulk${n}@example.com`,
      name: `Bulk ${n}`,
      visits: n,
    }));
    const inserted = await database.users
      .insert(rows)
      .returning((users) => ({ email: users.email }));
    expect(inserted).toHaveLength(22_000);
    expect(inserted.at(-1)).toEqual({ email: "bulk21999@example.com" });
    await expect(
      database.users
        .insert([
          ...rows.slice(1).map((row) => ({ ...row, email: `x${row.email}` })),
          rows[0]!,
        ])
        .execute(),
    ).rejects.toThrow();
    expect(
      await database.users((users, { count }) => ({ total: count() })).one(),
    ).toEqual({ total: 22_000 });
    // Inside a transaction the chunks use a savepoint and share its fate.
    await expect(
      database.$transaction(async (transaction) => {
        await transaction.users
          .insert(rows.map((row) => ({ ...row, email: `t${row.email}` })))
          .execute();
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(
      await database.users((users, { count }) => ({ total: count() })).one(),
    ).toEqual({ total: 22_000 });
  });

  test("undefined fields, operations and relations are omitted", async () => {
    const post = await database.posts
      .insert({
        slug: "first",
        title: "First",
        author: {
          create: { email: "ada", name: "Ada", visits: undefined },
          connect: undefined,
        },
        tags: { connect: undefined, connectOrCreate: [{ label: "bun" }] },
      })
      .returning((posts) => ({ authorId: posts.authorId }));
    expect((await database.users.byId(post.authorId).one()).visits).toBe(
      9007199254740993n,
    );
    // An undefined relation keeps the flat single-statement INSERT.
    const flat = database.posts.insert({
      slug: "second",
      title: "Second",
      authorId: post.authorId,
      author: undefined,
      tags: undefined,
    });
    expect(flat.toSQL().sql).toStartWith('INSERT INTO "posts"');
    await flat.execute();
    await database.posts
      .insert({
        slug: "third",
        title: "Third",
        author: { connect: { email: "ada" }, create: undefined },
      })
      .execute();
    expect(
      await database.posts(
        (posts) => ({
          slug: posts.slug,
          authorId: posts.authorId,
        }),
        { orderBy: (posts) => posts.id.ascending },
      ),
    ).toEqual([
      { slug: "first", authorId: post.authorId },
      { slug: "second", authorId: post.authorId },
      { slug: "third", authorId: post.authorId },
    ]);
  });

  test("snapshots custom codec values before cloning and decodes nested returning", async () => {
    let cents = 9007199254740993n;
    const query = database.wallets
      .insert({
        amount: { cents: () => cents },
        owner: { create: { email: "ada", name: "Ada" } },
      })
      .returning((wallets) => [wallets.id, wallets.amount]);
    cents = 1n;
    const wallet = await query.execute();
    expect(wallet.amount.cents()).toBe(9007199254740993n);
    await database.users
      .insert({
        email: "grace",
        name: "Grace",
        wallets: { connect: [{ amount: { cents: () => 9007199254740993n } }] },
      })
      .execute();
    const owner = await database.users.by.email("grace").one();
    expect((await database.wallets.byId(wallet!.id).one()).ownerId).toBe(
      owner.id,
    );
  });

  test("concurrent connectOrCreate uses one unique target across connections", async () => {
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${namespace}`);
    const concurrent = createDatabase({
      schema: model,
      driver: postgres({ url: url.toString(), max: 2 }),
    });
    await database.users.insert({ email: "ada", name: "Ada" }).execute();

    try {
      await Promise.all(
        ["first", "second"].map((slug) =>
          concurrent.posts
            .insert({
              slug,
              title: slug,
              author: { connect: { email: "ada" } },
              tags: { connectOrCreate: [{ label: "shared" }] },
            })
            .execute(),
        ),
      );
      expect(
        await database.tags((tags) => ({ label: tags.label })).execute(),
      ).toEqual([{ label: "shared" }]);
      expect(
        await database
          .postTags((postTags) => ({
            postId: postTags.postId,
            tagId: postTags.tagId,
          }))
          .execute(),
      ).toHaveLength(2);
    } finally {
      await concurrent.$close();
    }
  });

  test("recursively creates reverse children with inferred parent keys", async () => {
    const user = await database.users
      .insert({
        email: "ada",
        name: "Ada",
        posts: {
          create: [
            {
              slug: "first",
              title: "First",
              tags: { create: [{ label: "bun" }] },
            },
            { slug: "second", title: "Second" },
          ],
        },
      })
      .returning((users) => [users.id, users.visits, users.createdAt])
      .execute();
    expect(user!.visits).toBe(9007199254740993n);
    expect(user!.createdAt).toBeInstanceOf(Date);
    expect(
      await database.posts((posts) => ({ authorId: posts.authorId })).execute(),
    ).toEqual([{ authorId: user!.id }, { authorId: user!.id }]);
  });

  test("a late nested failure rolls back every row and nested savepoints permit recovery", async () => {
    await expect(
      database.posts
        .insert({
          slug: "failed",
          title: "Failed",
          author: { create: { email: "ada", name: "Ada" } },
          tags: { create: [{ label: "bun" }, { label: "rejected" }] },
        })
        .execute(),
    ).rejects.toThrow();
    expect(
      await database.users((users) => ({ id: users.id })).execute(),
    ).toEqual([]);
    expect(
      await database.posts((posts) => ({ id: posts.id })).execute(),
    ).toEqual([]);
    expect(await database.tags((tags) => ({ id: tags.id })).execute()).toEqual(
      [],
    );
    await database.$transaction(async (transaction) => {
      await transaction.users
        .insert({ email: "existing", name: "Existing" })
        .execute();
      await expect(
        transaction.posts
          .insert({
            slug: "failed",
            title: "Failed",
            author: { connect: { email: "existing" } },
            tags: { create: [{ label: "rejected" }] },
          })
          .execute(),
      ).rejects.toThrow();
      expect(await transaction.users.by.email("existing").one()).toMatchObject({
        name: "Existing",
      });
    });
    expect(
      await database.users((users) => ({ id: users.id })).execute(),
    ).toHaveLength(1);
  });

  test("a scoped database never rewrites, links or writes a row outside its scope", async () => {
    const [ada, bob] = await database.users
      .insert([
        { email: "ada", name: "Ada" },
        { email: "bob", name: "Bob" },
      ])
      .returning((users) => ({ id: users.id }));

    const cents = (value: bigint) => ({ cents: () => value });

    await database.wallets
      .insert([
        { ownerId: ada!.id, amount: cents(100n) },
        { ownerId: bob!.id, amount: cents(200n) },
      ])
      .execute();
    const acme = database.$scope({
      wallets: (wallets) => wallets.ownerId.is(ada!.id),
      tags: (tags) => tags.label.like("acme-%"),
    });
    await expect(
      acme.wallets
        .insert({ ownerId: ada!.id, amount: cents(200n) })
        .onConflict("amount")
        .doUpdate("ownerId")
        .returning((wallets) => ({ ownerId: wallets.ownerId }))
        .execute(),
    ).rejects.toMatchObject({
      code: "SYMMETRIA_OUT_OF_SCOPE",
      message: expect.stringContaining('upsert on "wallets"'),
    });
    await expect(
      acme.wallets
        .insert([
          { ownerId: ada!.id, amount: cents(300n) },
          { ownerId: ada!.id, amount: cents(200n) },
        ])
        .onConflict("amount")
        .doUpdate("ownerId")
        .execute(),
    ).rejects.toMatchObject({ code: "SYMMETRIA_OUT_OF_SCOPE" });
    // Updating the row inside the scope would move it out of the scope.
    await expect(
      acme.wallets
        .insert({ ownerId: bob!.id, amount: cents(100n) })
        .onConflict("amount")
        .doUpdate("ownerId")
        .returning((wallets) => ({ ownerId: wallets.ownerId }))
        .execute(),
    ).rejects.toMatchObject({
      code: "SYMMETRIA_OUT_OF_SCOPE",
      table: "wallets",
      message: expect.stringContaining(
        'insert on "wallets" would write a row outside the database scope',
      ),
    });
    expect(
      await acme.wallets
        .insert({ ownerId: ada!.id, amount: cents(100n) })
        .onConflict("amount")
        .doUpdate("ownerId")
        .returning((wallets) => ({ ownerId: wallets.ownerId })),
    ).toEqual({ ownerId: ada!.id });
    expect(
      await database.wallets(
        (wallets) => ({
          ownerId: wallets.ownerId,
        }),
        { orderBy: (wallets) => wallets.id.ascending },
      ),
    ).toEqual([{ ownerId: ada!.id }, { ownerId: bob!.id }]);

    await database.tags.insert({ label: "shared" }).execute();
    await expect(
      acme.posts
        .insert({
          slug: "first",
          title: "First",
          author: { create: { email: "eve", name: "Eve" } },
          tags: { connectOrCreate: [{ label: "shared" }] },
        })
        .execute(),
    ).rejects.toMatchObject({
      code: "SYMMETRIA_OUT_OF_SCOPE",
      message: expect.stringContaining('upsert on "tags"'),
    });
    expect(await database.posts.by.slug("first").maybeOne()).toBeNull();
    expect(await database.users.by.email("eve").maybeOne()).toBeNull();
    // A created row of a scoped table must satisfy its scope as well; the
    // whole nested insert rolls back.
    await expect(
      acme.posts
        .insert({
          slug: "first",
          title: "First",
          author: { create: { email: "eve", name: "Eve" } },
          tags: { create: [{ label: "acme-new" }, { label: "elsewhere" }] },
        })
        .execute(),
    ).rejects.toMatchObject({
      code: "SYMMETRIA_OUT_OF_SCOPE",
      table: "tags",
    });
    expect(await database.posts.by.slug("first").maybeOne()).toBeNull();
    expect(await database.tags.by.label("acme-new").maybeOne()).toBeNull();
    await acme.posts
      .insert({
        slug: "second",
        title: "Second",
        author: { create: { email: "eve", name: "Eve" } },
        tags: { connectOrCreate: [{ label: "acme-only" }] },
      })
      .execute();
    expect(
      await database.tags(
        (tags) => ({
          label: tags.label,
        }),
        { orderBy: (tags) => tags.label.ascending },
      ),
    ).toEqual([{ label: "acme-only" }, { label: "shared" }]);
  });

  test("sibling children are one multi-row INSERT, in input order", async () => {
    const insert = (table: string) => `INSERT INTO "${table}" AS "${table}"`;
    let created: unknown;

    // A parent with three children: two statements, not four.
    expect(
      await statements(async () => {
        created = await profiled.users
          .insert({
            email: "ada",
            name: "Ada",
            posts: {
              create: [
                { slug: "c", title: "C" },
                { slug: "a", title: "A" },
                { slug: "b", title: "B" },
              ],
            },
          })
          .returning((users) => ({ id: users.id, visits: users.visits }));
      }),
    ).toEqual([insert("users"), insert("posts")]);
    expect(created).toEqual({ id: 1, visits: 9007199254740993n });
    expect(
      await database.posts(
        (posts) => ({
          id: posts.id,
          slug: posts.slug,
          authorId: posts.authorId,
        }),
        { orderBy: (posts) => posts.id.ascending },
      ),
    ).toEqual([
      { id: 1, slug: "c", authorId: 1 },
      { id: 2, slug: "a", authorId: 1 },
      { id: 3, slug: "b", authorId: 1 },
    ]);

    // A child with relations of its own is written alone, between the runs
    // of plain siblings around it, so identities still follow the input.
    const sent = await statements(() =>
      profiled.users.insert([
        {
          email: "bob",
          name: "Bob",
          posts: {
            create: [
              { slug: "d", title: "D" },
              { slug: "e", title: "E" },
              {
                slug: "f",
                title: "F",
                tags: { create: [{ label: "x" }, { label: "y" }] },
              },
              { slug: "g", title: "G" },
              { slug: "h", title: "H" },
            ],
          },
        },
        { email: "cy", name: "Cy", posts: { create: [] } },
      ]),
    );
    expect(sent.filter((sql) => sql.startsWith("INSERT"))).toEqual([
      insert("users"),
      // d and e
      insert("posts"),
      // f, its two tags and both junction rows
      insert("posts"),
      insert("tags"),
      insert("tags"),
      `INSERT INTO "post_tags" AS "postTags"`,
      // g and h
      insert("posts"),
      insert("users"),
    ]);
    expect(sent).toHaveLength(8);
    expect(
      await database.posts((posts) => ({ id: posts.id, slug: posts.slug }), {
        where: (posts) => posts.authorId.is(2),
        orderBy: (posts) => posts.id.ascending,
      }),
    ).toEqual(
      ["d", "e", "f", "g", "h"].map((slug, position) => ({
        id: position + 4,
        slug,
      })),
    );
    expect(
      await database.postTags(
        (postTags) => ({ postId: postTags.postId, tagId: postTags.tagId }),
        { orderBy: (postTags) => postTags.tagId.ascending },
      ),
    ).toEqual([
      { postId: 6, tagId: 1 },
      { postId: 6, tagId: 2 },
    ]);

    // Rows connected by the same column are read together; upserted targets
    // are still resolved one by one. Junction rows are one INSERT per
    // operation, duplicates included.
    const linked = await statements(() =>
      profiled.posts.insert({
        slug: "i",
        title: "I",
        author: { connect: { email: "ada" } },
        tags: {
          connect: [{ label: "x" }, { label: "y" }, { label: "x" }],
          connectOrCreate: [{ label: "y" }, { label: "z" }],
        },
      }),
    );
    // The connected tags in one read, the author in another; "y" was read
    // already, "z" is looked for and then upserted: 1 + 1 + 1 + 1 + 2 + 1.
    expect(linked).toHaveLength(7);
    expect(linked.filter((sql) => sql.startsWith("SELECT"))).toHaveLength(3);
    expect(
      linked.filter((sql) => sql.startsWith('INSERT INTO "post_tags"')),
    ).toHaveLength(2);
    expect(linked.filter((sql) => sql.startsWith(insert("tags")))).toHaveLength(
      1,
    );
    expect(
      await database.postTags((postTags) => ({ tagId: postTags.tagId }), {
        where: (postTags) => postTags.postId.is(9),
        orderBy: (postTags) => postTags.tagId.ascending,
      }),
      // The existing "y" was only read, so "z" takes the next identity.
    ).toEqual([{ tagId: 1 }, { tagId: 2 }, { tagId: 3 }]);
  });

  test("a batch of siblings keeps defaults, codecs, value errors and rolls back as a whole", async () => {
    const cents = (value: bigint) => ({ cents: () => value });

    // Each relation is one statement; custom codecs encode every row's values.
    expect(
      await statements(() =>
        profiled.users.insert({
          email: "ada",
          name: "Ada",
          wallets: {
            create: [
              { amount: cents(9007199254740993n) },
              { amount: cents(2n) },
            ],
          },
          posts: {
            create: [
              { slug: "a", title: "A" },
              { slug: "b", title: "B" },
            ],
          },
        }),
      ),
    ).toHaveLength(3);
    expect(
      (
        await database.wallets((wallets) => ({ amount: wallets.amount }), {
          orderBy: (wallets) => wallets.id.ascending,
        })
      ).map((wallet) => wallet.amount.cents()),
    ).toEqual([9007199254740993n, 2n]);
    expect(
      await database.posts((posts) => ({ id: posts.id, slug: posts.slug }), {
        orderBy: (posts) => posts.slug.ascending,
      }),
    ).toEqual([
      { id: 1, slug: "a" },
      { id: 2, slug: "b" },
    ]);

    // A missing value in any sibling rejects the promise and writes nothing.
    const invalid = database.users.insert({
      email: "bob",
      name: "Bob",
      posts: {
        create: [
          { slug: "c", title: "C" },
          { slug: "d" } as { slug: string; title: string },
        ],
      },
    });
    await expect(invalid.execute()).rejects.toThrow(
      'symmetria: missing required column "posts.title"',
    );
    await expect(
      database.users
        .insert({
          email: "bob",
          name: "Bob",
          posts: {
            create: [
              { slug: "c", title: "C" },
              { slug: "e", title: "E", authorId: 1 } as never,
            ],
          },
        })
        .execute(),
    ).rejects.toThrow(
      "symmetria: nested reverse create cannot supply its parent foreign key",
    );
    // The second sibling breaks a unique constraint inside the statement.
    await expect(
      database.users
        .insert({
          email: "bob",
          name: "Bob",
          posts: {
            create: [
              { slug: "c", title: "C" },
              { slug: "a", title: "Again" },
            ],
          },
        })
        .execute(),
    ).rejects.toThrow(/unique/);
    expect(await database.users.by.email("bob").maybeOne()).toBeNull();
    expect(await database.posts.by.slug("c").maybeOne()).toBeNull();
  });

  test("siblings above the wire-protocol parameter limit are written together, atomically", async () => {
    const children = Array.from({ length: 22_000 }, (_, position) => ({
      slug: `slug-${position}`,
      title: `Title ${position}`,
    }));
    const sent = await statements(() =>
      profiled.users.insert({
        email: "ada",
        name: "Ada",
        posts: { create: children },
      }),
    );

    // The children are one statement of three arrays instead of 22,000 rows.
    expect(sent).toHaveLength(2);
    expect(
      await database.posts((posts) => ({ id: posts.id, slug: posts.slug }), {
        where: (posts) => posts.id.in([1, 11_000, 11_001, 22_000]),
        orderBy: (posts) => posts.id.ascending,
      }),
    ).toEqual([
      { id: 1, slug: "slug-0" },
      { id: 11_000, slug: "slug-10999" },
      { id: 11_001, slug: "slug-11000" },
      { id: 22_000, slug: "slug-21999" },
    ]);

    // A failure in the last chunk leaves nothing behind.
    await expect(
      database.users
        .insert({
          email: "bob",
          name: "Bob",
          posts: {
            create: [
              ...children.map((child) => ({
                ...child,
                slug: `other-${child.slug}`,
              })),
              { slug: "slug-0", title: "Duplicate" },
            ],
          },
        })
        .execute(),
    ).rejects.toThrow(/unique/);
    expect(await database.users.by.email("bob").maybeOne()).toBeNull();
    expect(await database.posts.count()).toBe(22_000);
  });

  test("nested inputs are snapshotted and missing connects cannot create orphans", async () => {
    const input = {
      slug: "first",
      title: "First",
      author: { create: { email: "ada", name: "Ada" } },
      tags: { create: [{ label: "bun" }] },
    };
    const query = database.posts.insert(input);
    input.author.create.email = "changed";
    input.tags.create[0]!.label = "changed";
    await query.execute();
    expect(await database.users.by.email("ada").one()).toMatchObject({
      name: "Ada",
    });
    expect(await database.tags.by.label("bun").one()).toMatchObject({
      label: "bun",
    });
    await expect(
      database.posts
        .insert({ slug: "missing", title: "Missing", author: { connect: 999 } })
        .execute(),
    ).rejects.toThrow(/existing row/);
    expect(await database.posts.by.slug("missing").maybeOne()).toBeNull();
  });

  test("rows that only connect are read and written together", async () => {
    const insert = (table: string) => `INSERT INTO "${table}" AS "${table}"`;

    await database.users.insert(
      Array.from({ length: 20 }, (_, position) => ({
        email: `u${position}`,
        name: `U${position}`,
      })),
    );

    // Twenty posts for twenty authors: one read of the authors, one INSERT.
    let created: { id: number; slug: string }[] = [];
    const sent = await statements(async () => {
      created = await profiled.posts
        .insert(
          Array.from({ length: 20 }, (_, position) => ({
            slug: `s${position}`,
            title: "T",
            // By key, by unique column, and one author twice.
            author:
              position % 2
                ? { connect: 1 + (position % 10) }
                : { connect: { email: `u${position}` } },
          })),
        )
        .returning("id", "slug");
    });

    expect(sent).toHaveLength(3);
    expect(sent.filter((sql) => sql.startsWith("SELECT"))).toHaveLength(2);
    expect(sent.at(-1)).toStartWith(insert("posts"));
    // In input order, as before.
    expect(created).toEqual(
      Array.from({ length: 20 }, (_, position) => ({
        id: position + 1,
        slug: `s${position}`,
      })),
    );
    expect(
      await database.posts((post) => ({ author: post.author.email }), {
        orderBy: { id: "asc" },
        limit: 4,
      }),
    ).toEqual([
      { author: "u0" },
      { author: "u1" },
      { author: "u2" },
      { author: "u3" },
    ]);

    // Children that only connect what they reference share their parent's INSERT.
    const withPosts = await statements(() =>
      profiled.users.insert({
        email: "writer",
        name: "Writer",
        posts: {
          create: Array.from({ length: 5 }, (_, position) => ({
            slug: `w${position}`,
            title: "W",
            tags: undefined,
          })),
        },
      }),
    );

    expect(withPosts).toHaveLength(2);

    // A row created by the same insert is found when a later row connects it,
    // and rows that need more than a connect keep their place in the order.
    const mixed = await profiled.posts
      .insert([
        { slug: "m0", title: "M", author: { connect: 1 } },
        {
          slug: "m1",
          title: "M",
          author: { create: { email: "fresh", name: "Fresh" } },
        },
        { slug: "m2", title: "M", author: { connect: { email: "fresh" } } },
        { slug: "m3", title: "M", author: { connect: 2 } },
      ])
      .returning("slug", "authorId");

    expect(mixed).toEqual([
      { slug: "m0", authorId: 1 },
      { slug: "m1", authorId: 22 },
      { slug: "m2", authorId: 22 },
      { slug: "m3", authorId: 2 },
    ]);

    // One missing row among many fails the whole insert.
    await expect(
      database.posts
        .insert([
          { slug: "x0", title: "X", author: { connect: 1 } },
          { slug: "x1", title: "X", author: { connect: 999 } },
          { slug: "x2", title: "X", author: { connect: 2 } },
        ])
        .execute(),
    ).rejects.toThrow('connect on "users" expected one existing row');
    expect(await database.posts.by.slug("x0").maybeOne()).toBeNull();

    // A scope still decides which rows a connect can find.
    const scoped = database.$scope({ users: (user) => user.id.atMost(2) });

    await expect(
      scoped.posts
        .insert([
          { slug: "y0", title: "Y", author: { connect: 1 } },
          { slug: "y1", title: "Y", author: { connect: 3 } },
        ])
        .execute(),
    ).rejects.toThrow('connect on "users" expected one existing row');
    expect(
      await scoped.posts
        .insert([
          { slug: "z0", title: "Z", author: { connect: 1 } },
          { slug: "z1", title: "Z", author: { connect: 2 } },
        ])
        .returning("authorId"),
    ).toEqual([{ authorId: 1 }, { authorId: 2 }]);
  });
});

// Keys whose value as read is not the value stored, and relations the model
// above has not: one-to-one slots, self relations, keys of other types.
const keyText = customType<string>("text", {
  encode: (value) => value,
  decode: (value) => String(value),
});
const batches = table({
  id: int.auto,
  name: text,
  startedAt: timestamptz.now.unique,
  items: many,
});
const items = table({
  id: int.auto,
  label: text,
  batch: one(batches.items).by("startedAt"),
});
const moments = table({
  at: timestamptz.primaryKey,
  label: text.unique,
  notes: many,
});
const labels = table({ id: int.auto, label: keyText.unique, notes: many });
const notes = table({
  id: int.auto,
  body: text,
  moments: many(moments.notes),
  labels: many(labels.notes),
  codes: many,
  replies: many,
});
const codes = table({
  id: int.auto,
  at: timestamptz.nullable.unique,
  big: bigint.nullable.unique,
  amount: numeric(10, 2).nullable.unique,
  scope: int.nullable,
  code: text.nullable,
  note: maybe(notes.codes),
}).indexes((codes) => ({
  identity: index(codes.scope, codes.code).unique,
}));
const accounts = table({ id: int.auto, name: text.unique, profile: one });
const profiles = table({
  id: int.auto,
  account: one(accounts.profile),
  handle: text.unique,
});
const replies = table({
  id: int.auto,
  body: text.unique,
  note: one(notes.replies),
  parent: maybe(self.children),
  children: many,
});
// A decoder that takes only what a plain read returns, not the JSON form.
const strictBytes = customType<Uint8Array>("bytea", {
  encode: (value) => value,
  decode: (value) => {
    if (!(value instanceof Uint8Array)) {
      throw new Error(`bytes expected, got ${JSON.stringify(value)}`);
    }

    return value;
  },
});
const files = table({
  hash: bytea.primaryKey,
  name: text.unique,
  blob: strictBytes.nullable,
  parts: many,
});
const parts = table({ id: int.auto, name: text, file: maybe(files.parts) });
const keyed = schema({
  batches,
  items,
  moments,
  labels,
  notes,
  codes,
  accounts,
  profiles,
  replies,
  files,
  parts,
});

describe.skipIf(!databaseUrl)("nested insert keys on PostgreSQL", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof keyed>>>;
  let database: typeof isolated.database;

  const rows = async (statement: string) => {
    const result = await isolated.driver.execute({
      sql: statement,
      parameters: [],
    });

    return Array.isArray(result) ? result : result.rows;
  };

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: keyed,
      prefix: "symmetria_nested_keys",
      max: 4,
    });
    database = isolated.database;
  });

  beforeEach(async () => {
    await rows(
      "TRUNCATE batches, items, moments, labels, notes, codes, accounts, profiles, replies, notes_moments, notes_labels, files, parts RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("foreign keys store the key as PostgreSQL has it, to the microsecond", async () => {
    // B's key is A's cut to milliseconds, as a JavaScript Date would read it.
    await rows(
      "INSERT INTO batches (name, started_at) VALUES ('A', '2024-05-01 10:00:00.123456+00'), ('B', '2024-05-01 10:00:00.123+00')",
    );
    // The key read by a connect, alone and for rows that only connect.
    await database.items.insert({ label: "a1", batch: { connect: { id: 1 } } });
    await database.items.insert([
      { label: "a2", batch: { connect: { id: 1 } } },
      { label: "b1", batch: { connect: { id: 2 } } },
    ]);
    // The key read back from RETURNING: a parent keyed by its now() default.
    await database.batches.insert({
      name: "C",
      items: { create: [{ label: "c1" }, { label: "c2" }] },
    });
    await database.items.insert({
      label: "d1",
      batch: { create: { name: "D" } },
    });
    // A reverse connect moves a1 to a new parent.
    await database.batches.insert({ name: "E", items: { connect: [1] } });
    expect(
      await rows(
        "SELECT i.label, b.name FROM items i JOIN batches b ON b.started_at = i.batch_id ORDER BY i.id",
      ),
    ).toEqual([
      { label: "a1", name: "E" },
      { label: "a2", name: "A" },
      { label: "b1", name: "B" },
      { label: "c1", name: "C" },
      { label: "c2", name: "C" },
      { label: "d1", name: "D" },
    ]);

    // Junction rows store both keys exactly: connected, created and upserted.
    await rows(
      "INSERT INTO moments (at, label) VALUES ('2024-05-01 10:00:00.123456+00', 'm1'), ('2024-05-01 10:00:00.123+00', 'm2')",
    );
    // Timestamp text, which a Date cannot hold to the microsecond.
    const at = (text: string) => text as unknown as Date;

    await database.notes.insert({
      body: "n",
      moments: {
        connect: [{ label: "m1" }],
        create: [{ at: at("2024-05-02 10:00:00.000001+00"), label: "m3" }],
        connectOrCreate: [
          { at: at("2024-05-03 10:00:00.000002+00"), label: "m4" },
        ],
      },
    });
    expect(
      await database.notes((note) => ({
        moments: note.moments((moment) => ({ label: moment.label }), {
          orderBy: (moment) => moment.label.ascending,
        }),
      })),
    ).toEqual([
      { moments: [{ label: "m1" }, { label: "m3" }, { label: "m4" }] },
    ]);
  });

  test("connectOrCreate entries are created in key order, for every type of key", async () => {
    const created = async (
      entries: Record<string, unknown>[],
      column: string,
    ) => {
      await rows("TRUNCATE codes, notes RESTART IDENTITY CASCADE");
      await database.notes.insert({
        body: "n",
        codes: { connectOrCreate: entries as never },
      });

      return (
        await rows(`SELECT ${column} AS value FROM codes ORDER BY id`)
      ).map((row) => row.value);
    };

    // Not by the Date's local text, which begins with the weekday.
    expect(
      await created(
        [
          { at: new Date("2024-01-05T12:00:00Z") },
          { at: new Date("2024-01-04T12:00:00Z") },
        ],
        "to_char(at AT TIME ZONE 'UTC', 'MM-DD')",
      ),
    ).toEqual(["01-04", "01-05"]);
    // Numbers by value, not by their text.
    expect(
      await created(
        [{ big: 10n }, { big: 9007199254740993n }, { big: 9 }],
        "big::text",
      ),
    ).toEqual(["9", "10", "9007199254740993"]);
    expect(
      await created(
        [{ amount: "10.50" }, { amount: "9.25" }, { amount: "-1" }],
        "amount::text",
      ),
    ).toEqual(["-1.00", "9.25", "10.50"]);
    // A composite key column by column.
    expect(
      await created(
        [
          { scope: 1, code: "b" },
          { scope: 1, code: "a" },
          { scope: 0, code: "z" },
        ],
        "scope || code",
      ),
    ).toEqual(["0z", "1a", "1b"]);
    // A customType() key by the value it sends.
    await database.notes.insert({
      body: "n",
      labels: {
        connectOrCreate: [{ label: "c" }, { label: "b" }, { label: "a" }],
      },
    });
    expect(
      await rows("SELECT string_agg(label, ',' ORDER BY id) AS o FROM labels"),
    ).toEqual([{ o: "a,b,c" }]);
  });

  test("concurrent inserts that create the same rows in opposite orders do not deadlock", async () => {
    for (let round = 0; round < 4; round += 1) {
      const entries = [1, 2, 3].map((key) => ({ label: `r${round}-${key}` }));
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, (_, caller) =>
          database.notes.insert({
            body: `${caller}`,
            labels: {
              connectOrCreate: caller % 2 ? entries : [...entries].reverse(),
            },
          }),
        ),
      );

      expect(
        results.flatMap((result) =>
          result.status === "rejected" ? [String(result.reason)] : [],
        ),
      ).toEqual([]);
    }

    expect(await rows("SELECT count(*)::int AS n FROM labels")).toEqual([
      { n: 12 },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM notes_labels")).toEqual([
      { n: 48 },
    ]);
  });

  test("a one-to-one connectOrCreate finds the row by its own key, not the new parent's", async () => {
    await rows("INSERT INTO accounts (name) VALUES ('old')");
    await rows("INSERT INTO profiles (account_id, handle) VALUES (1, 'eve')");

    // The profile's account key is declared first; the new account has no
    // profile yet, so the existing one is found by its handle and moves.
    const account = await database.accounts
      .insert({ name: "new", profile: { connectOrCreate: { handle: "eve" } } })
      .returning("id");
    const other = await database.accounts
      .insert({
        name: "other",
        profile: { connectOrCreate: { handle: "ann" } },
      })
      .returning("id");

    expect(
      await rows("SELECT account_id, handle FROM profiles ORDER BY id"),
    ).toEqual([
      { account_id: account.id, handle: "eve" },
      { account_id: other.id, handle: "ann" },
    ]);
  });

  test("a later row connects a row the same multi-row INSERT writes", async () => {
    const note = await database.notes.insert({ body: "n" }).returning("id");

    // Roots that only connect, the second replying to the first.
    await database.replies.insert([
      { body: "a", note: { connect: note.id } },
      {
        body: "b",
        note: { connect: note.id },
        parent: { connect: { body: "a" } },
      },
      {
        body: "c",
        note: { connect: note.id },
        parent: { connect: { body: "b" } },
      },
    ]);
    // Children of one parent, replying to a sibling and to an older row.
    await database.notes.insert({
      body: "m",
      replies: {
        create: [
          { body: "d" },
          { body: "e", parent: { connect: { body: "d" } } },
          { body: "f", parent: { connect: { body: "a" } } },
        ],
      },
    });
    expect(
      await rows(
        "SELECT r.body, p.body AS parent FROM replies r LEFT JOIN replies p ON p.id = r.parent_id ORDER BY r.id",
      ),
    ).toEqual([
      { body: "a", parent: null },
      { body: "b", parent: "a" },
      { body: "c", parent: "b" },
      { body: "d", parent: null },
      { body: "e", parent: "d" },
      { body: "f", parent: "a" },
    ]);

    // A row that is nowhere still fails the whole insert.
    await expect(
      database.replies
        .insert([
          { body: "g", note: { connect: note.id } },
          {
            body: "h",
            note: { connect: note.id },
            parent: { connect: { body: "missing" } },
          },
        ])
        .execute(),
    ).rejects.toMatchObject({ code: "SYMMETRIA_RECORD_NOT_FOUND" });
    expect(await database.replies.by.body("g").maybeOne()).toBeNull();
  });

  test("connectOrCreate leaves the payload's relation fields out", async () => {
    // A row loaded with its relations and passed on as it is.
    const profile = await database.profiles
      .insert({
        handle: "p1",
        account: {
          connectOrCreate: {
            name: "fresh",
            profile: { create: { handle: "ignored" } },
          } as never,
        },
      })
      .returning("accountId");
    await database.notes.insert({ body: "n" });
    await database.notes.insert({
      body: "m",
      labels: {
        connectOrCreate: [{ label: "x", notes: { connect: [1] } } as never],
      },
    });

    expect(await database.accounts.by.name("fresh").one()).toMatchObject({
      id: profile.accountId,
    });
    expect(await database.profiles.by.handle("ignored").maybeOne()).toBeNull();
    expect(await rows("SELECT notes_id FROM notes_labels")).toEqual([
      { notes_id: 2 },
    ]);
  });

  test("connects read together find the row PostgreSQL compares equal, not one that reads the same", async () => {
    // Both keys read as the same Date; A, read last, used to take B's place.
    await rows(
      "INSERT INTO batches (name, started_at) VALUES ('B', '2024-05-01 10:00:00.123+00'), ('A', '2024-05-01 10:00:00.123456+00'), ('C', '2024-05-01 10:00:01+00')",
    );
    const at = (text: string) => text as unknown as Date;

    await database.items.insert([
      {
        label: "b",
        batch: { connect: { startedAt: new Date("2024-05-01T10:00:00.123Z") } },
      },
      {
        label: "a",
        batch: { connect: { startedAt: at("2024-05-01 10:00:00.123456+00") } },
      },
      // The same row in another spelling, and a scalar Date.
      {
        label: "a2",
        batch: { connect: { startedAt: at("2024-05-01T12:00:00.123456+02") } },
      },
      { label: "c", batch: { connect: new Date("2024-05-01T10:00:01Z") } },
    ]);
    // connectOrCreate takes a row the connects read.
    await database.items.insert([
      {
        label: "x",
        batch: { connect: { startedAt: at("2024-05-01 10:00:01+00") } },
      },
      {
        label: "y",
        batch: { connect: { startedAt: new Date("2024-05-01T10:00:00.123Z") } },
      },
      {
        label: "b2",
        batch: {
          connectOrCreate: {
            name: "new",
            startedAt: new Date("2024-05-01T10:00:00.123Z"),
          },
        },
      },
    ]);
    expect(
      await rows(
        "SELECT i.label, b.name FROM items i JOIN batches b ON b.started_at = i.batch_id ORDER BY i.id",
      ),
    ).toEqual([
      { label: "b", name: "B" },
      { label: "a", name: "A" },
      { label: "a2", name: "A" },
      { label: "c", name: "C" },
      { label: "x", name: "C" },
      { label: "y", name: "B" },
      { label: "b2", name: "B" },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM batches")).toEqual([
      { n: 3 },
    ]);
  });

  test("connect takes a Date or bytes as the key, and reads rows as plain reads do", async () => {
    await rows(
      "INSERT INTO files (hash, name, blob) VALUES ('\\x0102', 'f', '\\x03'), ('\\x0a', 'g', NULL)",
    );
    await rows(
      "INSERT INTO moments (at, label) VALUES ('2024-05-01 10:00:00+00', 'm')",
    );
    // A key value that is an object in JavaScript is not a key object.
    await database.parts.insert({
      name: "p1",
      file: { connect: new Uint8Array([1, 2]) },
    });
    await database.parts.insert({
      name: "p2",
      file: { connect: Buffer.from([10]) },
    });
    await database.notes.insert({
      body: "n",
      moments: { connect: [new Date("2024-05-01T10:00:00Z")] },
    });
    // Other columns reach their decoders as a plain read returns them.
    await database.parts.insert([
      { name: "p3", file: { connect: { name: "f" } } },
      { name: "p4", file: { connect: { name: "g" } } },
    ]);
    await database.parts.insert({
      name: "p5",
      file: { connectOrCreate: { hash: new Uint8Array([1, 2]), name: "f" } },
    });
    await database.files.insert({
      hash: new Uint8Array([4]),
      name: "h",
      parts: { connect: [1, 2] },
    });
    expect(
      await rows(
        "SELECT p.name, encode(p.file_id, 'hex') AS file FROM parts p ORDER BY p.id",
      ),
    ).toEqual([
      { name: "p1", file: "04" },
      { name: "p2", file: "04" },
      { name: "p3", file: "0102" },
      { name: "p4", file: "0a" },
      { name: "p5", file: "0102" },
    ]);
    expect(await rows("SELECT notes_id FROM notes_moments")).toEqual([
      { notes_id: 1 },
    ]);
    // An object that names no unique key is still refused.
    await expect(
      database.parts
        .insert({ name: "p6", file: { connect: { blob: null } as never } })
        .execute(),
    ).rejects.toThrow("requires a complete non-null unique key");
  });

  test("concurrent inserts that connect the same rows in opposite orders do not deadlock", async () => {
    await database.notes.insert({ body: "n" });

    for (let round = 0; round < 4; round += 1) {
      await rows(
        `INSERT INTO codes (code) SELECT 'r${round}-' || g FROM generate_series(1, 4) g`,
      );
      const keys = await rows(
        `SELECT id FROM codes WHERE code LIKE 'r${round}-%' ORDER BY id`,
      );
      const ids = keys.map((key) => key.id as number);
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, (_, caller) =>
          database.notes.insert({
            body: `${round}-${caller}`,
            codes: { connect: caller % 2 ? ids : [...ids].reverse() },
          }),
        ),
      );

      expect(
        results.flatMap((result) =>
          result.status === "rejected" ? [String(result.reason)] : [],
        ),
      ).toEqual([]);
    }
  });

  test("concurrent inserts that name the same rows by another key or operation do not deadlock", async () => {
    await database.notes.insert({ body: "n" });

    for (let round = 0; round < 4; round += 1) {
      // Ids ascend while `big` descends: one key's order is the other's reverse.
      await rows(
        `INSERT INTO codes (big) SELECT ${round * 10 + 5} - g FROM generate_series(1, 4) g ORDER BY g`,
      );
      const found = await rows(
        `SELECT id, big::text AS big FROM codes WHERE big BETWEEN ${round * 10 + 1} AND ${round * 10 + 4} ORDER BY id`,
      );
      const ids = found.map((row) => row.id as number);
      const bigs = found.map((row) => ({ big: BigInt(row.big as string) }));
      const operations = [
        { connect: ids },
        { connectOrCreate: bigs },
        // Both operations in one insert, each naming half of the rows.
        { connect: ids.slice(0, 2), connectOrCreate: bigs.slice(2) },
        { connectOrCreate: bigs.slice(0, 2), connect: ids.slice(2) },
      ];
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, caller) =>
          database.notes.insert({
            body: `${round}-${caller}`,
            codes: operations[caller % 4]!,
          }),
        ),
      );

      expect(
        results.flatMap((result) =>
          result.status === "rejected" ? [String(result.reason)] : [],
        ),
      ).toEqual([]);
    }
  });

  test("rows of one relation are moved to the parent in primary-key order, after they are all found", async () => {
    const profiler = createProfiler();
    const profiled = createDatabase({
      schema: keyed,
      driver: profiler.driver(isolated.driver),
    });

    await database.notes.insert({ body: "n" });
    await rows(
      "INSERT INTO codes (big) SELECT 5 - g FROM generate_series(1, 4) g ORDER BY g",
    );
    await profiler.trace("insert", () =>
      profiled.notes.insert({
        body: "m",
        codes: {
          connectOrCreate: [{ big: 1n }, { big: 9n }, { big: 3n }],
          connect: [2],
          // A create after the rows moved is written after them.
          create: [{ code: "late" }],
        },
      }),
    );
    const statements = profiler
      .snapshot()
      .at(-1)!
      .queries.filter((query) => query.sql.includes('"codes"'))
      .map((query) =>
        query.sql.startsWith("UPDATE")
          ? `UPDATE ${String(query.parameters.at(-1))}`
          : query.sql.split(" ")[0]!,
      );

    // Rows 4 and 2 are found, the row for 9 is created (id 5), 3 is row 2
    // again; then all of them move in primary-key order.
    expect(statements.filter((name) => name.startsWith("UPDATE"))).toEqual([
      "UPDATE 2",
      "UPDATE 2",
      "UPDATE 4",
      "UPDATE 5",
    ]);
    expect(statements.at(-1)).toBe("INSERT");
    expect(
      await rows(
        "SELECT string_agg(coalesce(big::text, code), ',' ORDER BY id) AS o FROM codes WHERE note_id = 2",
      ),
    ).toEqual([{ o: "3,1,9,late" }]);
  });

  test("connects of many rows by a key a read cannot tell apart compare each value with the table once", async () => {
    const profiler = createProfiler();
    const profiled = createDatabase({
      schema: keyed,
      driver: profiler.driver(isolated.driver),
    });
    const count = 2_500;
    const start = Date.parse("2024-05-01T10:00:00Z");

    await rows(
      `INSERT INTO batches (name, started_at) SELECT 'b' || g, timestamptz '2024-05-01 10:00:00+00' + g * interval '1 second' FROM generate_series(0, ${count - 1}) g`,
    );
    await profiler.trace("insert", () =>
      profiled.items.insert(
        Array.from({ length: count }, (_, index) => ({
          label: `b${index}`,
          batch: { connect: new Date(start + index * 1000) },
        })),
      ),
    );
    const reads = profiler
      .snapshot()
      .at(-1)!
      .queries.filter((query) => query.sql.startsWith("SELECT"));

    // One read, which joins the values with the table: a CASE with a
    // branch per value compared every row with every value.
    expect(reads).toHaveLength(1);
    expect(reads[0]!.sql).toContain("WITH ORDINALITY");
    expect(reads[0]!.sql).not.toContain("CASE");
    expect(
      await rows(
        "SELECT count(*)::int AS n FROM items i JOIN batches b ON b.started_at = i.batch_id WHERE b.name = i.label",
      ),
    ).toEqual([{ n: count }]);
  });
});

// A session whose dates, times and doubles print in another form: keys are
// copied in a form that reads back as the stored value. node-postgres sets
// DateStyle and extra_float_digits itself; the time zone still applies.
const stamps = table({
  at: timestamptz.primaryKey,
  label: text.unique,
  entries: many,
});
const entries = table({
  id: int.auto,
  label: text.unique,
  stamp: maybe(stamps.entries),
});
const ratios = table({
  value: doublePrecision.primaryKey,
  label: text.unique,
  shares: many,
});
const shares = table({
  id: int.auto,
  label: text.unique,
  ratio: maybe(ratios.shares),
});
const styled = schema({ stamps, entries, ratios, shares });

describe.skipIf(!databaseUrl || transactionPooling)(
  "nested insert keys in a session with other date and number styles",
  () => {
    let isolated: Awaited<ReturnType<typeof isolatedDatabase<typeof styled>>>;

    const rows = async (statement: string) => {
      const result = await isolated.driver.execute({
        sql: statement,
        parameters: [],
      });

      return Array.isArray(result) ? result : result.rows;
    };

    beforeAll(async () => {
      isolated = await isolatedDatabase({
        url: databaseUrl!,
        schema: styled,
        prefix: "symmetria_nested_styles",
        max: 2,
        driver: ({ url: address, max }) => {
          const url = new URL(address);

          // Asia/Shanghai prints as CST, which PostgreSQL reads as US Central.
          url.searchParams.set(
            "options",
            `${url.searchParams.get("options") ?? ""} -c DateStyle=SQL,DMY -c TimeZone=Asia/Shanghai -c extra_float_digits=-3`.trim(),
          );

          return postgres({ url: url.toString(), max });
        },
      });
    });

    afterAll(async () => {
      await isolated?.close();
    });

    test("foreign keys hold the parent's key exactly", async () => {
      const { database } = isolated;

      await rows(
        "INSERT INTO stamps (at, label) VALUES ('2024-01-01 12:00:00.123456+00', 'noon'), ('2024-01-02 02:00:00.123456+00', 'next')",
      );
      await rows(
        "INSERT INTO ratios (value, label) VALUES (0.30000000000000004, 'sum'), (0.3, 'three')",
      );
      const at = (text: string) => text as unknown as Date;

      await database.entries.insert({
        label: "e1",
        stamp: { connect: at("2024-01-01 12:00:00.123456+00") },
      });
      await database.entries.insert([
        {
          label: "e2",
          stamp: { connect: at("2024-01-02 02:00:00.123456+00") },
        },
        {
          label: "e3",
          stamp: { connect: { at: at("2024-01-01 12:00:00.123456+00") } },
        },
      ]);
      await database.entries.insert({
        label: "e4",
        stamp: {
          connectOrCreate: {
            at: at("2024-01-01 12:00:00.123456+00"),
            label: "noon",
          },
        },
      });
      await database.stamps.insert({
        at: new Date("2025-06-01T08:00:00.5Z"),
        label: "new",
        entries: { create: [{ label: "e5" }], connect: [{ label: "e1" }] },
      });
      await database.ratios.insert({
        value: 0.1 + 0.7,
        label: "new",
        shares: { create: [{ label: "s1" }] },
      });
      await database.shares.insert([
        { label: "s2", ratio: { connect: 0.30000000000000004 } },
        { label: "s3", ratio: { connect: 0.3 } },
      ]);

      expect(
        await rows(
          "SELECT e.label, s.label AS stamp FROM entries e JOIN stamps s ON s.at = e.stamp_id ORDER BY e.id",
        ),
      ).toEqual([
        { label: "e1", stamp: "new" },
        { label: "e2", stamp: "next" },
        { label: "e3", stamp: "noon" },
        { label: "e4", stamp: "noon" },
        { label: "e5", stamp: "new" },
      ]);
      expect(
        await rows(
          "SELECT s.label, r.label AS ratio FROM shares s JOIN ratios r ON r.value = s.ratio_id ORDER BY s.id",
        ),
      ).toEqual([
        { label: "s1", ratio: "new" },
        { label: "s2", ratio: "sum" },
        { label: "s3", ratio: "three" },
      ]);
    });
  },
);

// Keys that hold timestamps without being one, a range or an array, in a
// Bun session that prints dates in another style: Asia/Shanghai prints as
// CST, which PostgreSQL reads as US Central. node-postgres sets DateStyle.
// (Bun reads a timestamptz array in that style as an invalid Date, so the
// test never reads one.)
const stampRange = customType<string>("tstzrange", {
  base: "tstzrange",
  encode: (value) => value,
  decode: (value) => String(value),
});
const periods = table({
  id: int.auto,
  span: stampRange.unique,
  label: text.unique,
  bookings: many,
});
const bookings = table({
  id: int.auto,
  label: text.unique,
  period: maybe(periods.bookings).by("span"),
});
const instants = table({
  id: int.auto,
  moments: timestamptz.array.unique,
  label: text.unique,
  visits: many,
});
const visits = table({
  id: int.auto,
  label: text.unique,
  instant: maybe(instants.visits).by("moments"),
});
const periodKeys = schema({ periods, bookings, instants, visits });

describe.skipIf(!databaseUrl || transactionPooling)(
  "nested insert keys of ranges and arrays under DateStyle SQL",
  () => {
    let isolated: Awaited<
      ReturnType<typeof isolatedDatabase<typeof periodKeys>>
    >;

    const rows = async (statement: string) => {
      const result = await isolated.driver.execute({
        sql: statement,
        parameters: [],
      });

      return Array.isArray(result) ? result : result.rows;
    };

    beforeAll(async () => {
      isolated = await isolatedDatabase({
        url: databaseUrl!,
        schema: periodKeys,
        prefix: "symmetria_nested_period_keys",
        max: 2,
        driver: ({ url, max }) =>
          bun({
            url,
            max,
            connection: { DateStyle: "SQL, MDY", TimeZone: "Asia/Shanghai" },
          }),
      });
    });

    afterAll(async () => {
      await isolated?.close();
    });

    test("keys holding timestamps are copied exactly", async () => {
      const { database } = isolated;

      await rows(
        "INSERT INTO periods (span, label) VALUES ('[2024-01-01 12:00+00,2024-01-02 12:00+00)', 'first'), ('[2024-01-02 02:00+00,2024-01-03 02:00+00)', 'second')",
      );
      await rows("INSERT INTO bookings (label) VALUES ('moved')");
      await rows("INSERT INTO visits (label) VALUES ('moved')");

      await database.periods.insert({
        span: "[2025-06-01 08:00+00,2025-06-02 08:00+00)",
        label: "new",
        bookings: {
          create: [{ label: "b1" }],
          connect: [{ label: "moved" }],
        },
      });
      await database.bookings.insert({
        label: "b2",
        period: { connect: "[2024-01-01 12:00+00,2024-01-02 12:00+00)" },
      });
      await database.instants.insert({
        moments: [new Date("2025-06-01T08:00:00Z")],
        label: "new",
        visits: {
          create: [{ label: "v1" }],
          connect: [{ label: "moved" }],
        },
      });

      expect(
        await rows(
          "SELECT b.label, p.label AS period FROM bookings b JOIN periods p ON p.span = b.period_id ORDER BY b.label",
        ),
      ).toEqual([
        { label: "b1", period: "new" },
        { label: "b2", period: "first" },
        { label: "moved", period: "new" },
      ]);
      expect(
        await rows(
          "SELECT v.label, i.label AS instant FROM visits v JOIN instants i ON i.moments = v.instant_id ORDER BY v.label",
        ),
      ).toEqual([
        { label: "moved", instant: "new" },
        { label: "v1", instant: "new" },
      ]);
    });
  },
);
