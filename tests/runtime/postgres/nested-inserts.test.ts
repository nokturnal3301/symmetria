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
  timestamptz,
  index,
  sql,
  customType,
} from "../../../packages/runtime/src";
import { postgres } from "../../../packages/runtime/src/driver";
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
  const driver = postgres({
    url: databaseUrl ?? "postgres://localhost/postgres",
    max: 1,
  });
  const database = createDatabase({ schema: model, driver });
  const namespace = `symmetria_nested_${crypto.randomUUID().replaceAll("-", "")}`;

  const run = (statement: string) =>
    driver.execute({ sql: statement, parameters: [] });

  beforeAll(async () => {
    await run(`CREATE SCHEMA "${namespace}"`);
    await run(`SET search_path TO "${namespace}"`);

    for (const statement of createSchemaSQL(model.$snapshot())) {
      await driver.execute(statement);
    }
  });

  beforeEach(async () => {
    await run(
      "TRUNCATE users, posts, tags, post_tags, handles RESTART IDENTITY CASCADE",
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
});
