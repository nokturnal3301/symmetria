import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  schema,
  table,
  link,
  many,
  int,
  text,
} from "../../../packages/runtime/src";
import { testDatabase } from "../../support/postgres";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;

const tags = table({ id: int.auto, label: text.unique, posts: many });
const posts = table({ id: int.auto, title: text.unique, tags: many });
const postTags = link(posts.tags, tags.posts, { tenantId: int.default(1) });
const declared = schema({ tags, posts, postTags });

describe.skipIf(!databaseUrl)("a scope on a junction table", () => {
  let isolated: Awaited<ReturnType<typeof testDatabase<typeof declared>>>;
  let post: number;
  let first: number;
  let second: number;

  const tenant = (id: number) =>
    isolated.database.$scope({
      postTags: (row) => row.tenantId.is(id),
    });

  beforeAll(async () => {
    isolated = await testDatabase({
      url: databaseUrl!,
      schema: declared,
      prefix: "symmetria_junction_scope",
      max: 2,
    });

    const database = isolated.database;
    const labels = await database.tags
      .insert([{ label: "first" }, { label: "second" }])
      .returning((tag) => ({ id: tag.id }));
    const written = await database.posts
      .insert([{ title: "post" }])
      .returning((row) => ({ id: row.id }));

    post = written[0]!.id;
    first = labels[0]!.id;
    second = labels[1]!.id;

    await database.postTags
      .insert([
        { postsId: post, tagsId: first, tenantId: 1 },
        { postsId: post, tagsId: second, tenantId: 2 },
      ])
      .execute();
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test("nested rows, counts and quantifiers see only the links the scope admits", async () => {
    for (const [id, label] of [
      [1, "first"],
      [2, "second"],
    ] as const) {
      const scoped = tenant(id);

      expect(
        await scoped.posts((row) => ({
          tags: row.tags((tag) => ({ label: tag.label })),
          total: row.tags.count(),
        })),
      ).toEqual([{ tags: [{ label }], total: 1 }]);
      expect(
        await scoped.tags(
          (tag) => ({
            label: tag.label,
            posts: tag.posts((row) => ({ title: row.title })),
          }),
          { orderBy: (tag) => tag.label.asc },
        ),
      ).toEqual([
        { label: "first", posts: id === 1 ? [{ title: "post" }] : [] },
        { label: "second", posts: id === 2 ? [{ title: "post" }] : [] },
      ]);
      expect(
        await scoped.posts((row) => ({ title: row.title }), {
          where: (row) => row.tags.some((tag) => tag.label.is("second")),
        }),
      ).toHaveLength(id === 2 ? 1 : 0);
      expect(
        await scoped.posts((row, { join }) => ({
          label: join(row.tags).label,
        })),
      ).toEqual([{ label }]);
      expect(
        await scoped.postTags((row) => ({ tag: row.tagsId })),
      ).toHaveLength(1);
    }
  });

  test("a scope that admits no link leaves the row with an empty list", async () => {
    expect(
      await tenant(3).posts((row) => ({
        title: row.title,
        tags: row.tags((tag) => ({ label: tag.label })),
        total: row.tags.count(),
      })),
    ).toEqual([{ title: "post", tags: [], total: 0 }]);
  });

  test("a nested connect writes a link only inside the scope", async () => {
    // The link row carries the two keys; tenantId comes from its default (1).
    await expect(
      tenant(2)
        .posts.insert({ title: "refused", tags: { connect: [{ id: first }] } })
        .execute(),
    ).rejects.toMatchObject({ code: "SYMMETRIA_OUT_OF_SCOPE" });
    expect(await isolated.database.posts.find({ title: "refused" })).toBeNull();

    await tenant(1)
      .posts.insert({ title: "linked", tags: { connect: [{ id: first }] } })
      .execute();

    expect(
      await tenant(1).posts.find({ title: "linked" }, (row) => ({
        tags: row.tags((tag) => ({ label: tag.label })),
      })),
    ).toEqual({ tags: [{ label: "first" }] });
  });

  test("deleting through the scope removes only its links", async () => {
    await tenant(2).postTags.delete().all().execute();

    expect(
      await isolated.database.postTags((row) => ({ tenant: row.tenantId })),
    ).toEqual([{ tenant: 1 }, { tenant: 1 }]);
  });

  test("a join of the relation under a scope on its target leaves out the hidden rows", async () => {
    const database = isolated.database;
    const [own] = await database.posts
      .insert([{ title: "both labels" }])
      .returning((row) => ({ id: row.id }));

    await database.postTags
      .insert([
        { postsId: own!.id, tagsId: first },
        { postsId: own!.id, tagsId: second },
      ])
      .execute();

    const visible = database.$scope({ tags: (tag) => tag.label.is("first") });

    // The link to "second" is no extra row with a NULL label.
    expect(
      await visible.posts(
        (row, { join }) => ({ title: row.title, label: join(row.tags).label }),
        { where: (row) => row.title.is("both labels") },
      ),
    ).toEqual([{ title: "both labels", label: "first" }]);
  });
});
