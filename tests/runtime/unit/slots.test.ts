import { expect, test } from "bun:test";
import {
  schema,
  table,
  junction,
  link,
  one,
  maybe,
  many,
  self,
  int,
  text,
  timestamptz,
} from "../../../packages/runtime/src";
import { migrationSnapshot, snapshotHash } from "../../../packages/kit/src";

const executor = async () => [];

/** The same schema in the slot syntax and in the reference syntax it stands for. */
const blog = () => {
  const users = table({
    id: int.auto,
    name: text,
    email: text.unique,
    posts: many,
    edited: many,
    profile: one,
    comments: many.cascade,
  });
  const posts = table({
    id: int.auto,
    title: text,
    author: one(users.posts),
    editor: maybe(users.edited).setNull,
  });
  const profiles = table({ id: int.auto, bio: text, user: one(users.profile) });
  const comments = table({
    id: int.auto,
    body: text,
    post: one(posts).cascade,
    author: one(users.comments).by("email").column("author_email"),
    parent: maybe(self.children).cascade,
    children: many,
  });

  return schema({ users, posts, profiles, comments }, { executor });
};
const classic = () => {
  const users = table({ id: int.auto, name: text, email: text.unique });
  const posts = table({
    id: int.auto,
    title: text,
    author: users.index.inverse("posts"),
    editor: users.nullable.index.onDelete.setNull.inverse("edited"),
  });
  const profiles = table({
    id: int.auto,
    bio: text,
    user: users.unique.inverse("profile"),
  });
  const comments = table({
    id: int.auto,
    body: text,
    post: posts.index.onDelete.cascade,
    author: users
      .by("email")
      .column("author_email")
      .index.onDelete.cascade.inverse("comments"),
    parent: self.nullable.index.onDelete.cascade.inverse("children"),
  });

  return schema({ users, posts, profiles, comments }, { executor });
};

test("slots lower to the references they stand for: same snapshot, same migration hash", () => {
  expect(blog().$snapshot()).toEqual(classic().$snapshot());
  expect(snapshotHash(migrationSnapshot(blog().$snapshot()))).toBe(
    snapshotHash(migrationSnapshot(classic().$snapshot())),
  );

  const snapshot = blog().$snapshot();
  const relations = (name: string) =>
    snapshot.tables
      .find((entry) => entry.name === name)!
      .relations.map((relation) => `${relation.name}:${relation.kind}`);

  expect(relations("users")).toEqual([
    "posts:many",
    "edited:many",
    "profile:one",
    "comments:many",
  ]);
  expect(relations("comments")).toEqual([
    "post:one",
    "author:one",
    "parent:one",
    "children:many",
  ]);
  // The short form names the reverse side after the referencing table.
  expect(relations("posts")).toEqual([
    "author:one",
    "editor:one",
    "comments:many",
  ]);
});

test("slots and claims compile to the usual joins and nested reads", () => {
  const database = blog();

  expect(
    database
      .users((user) => ({
        name: user.name,
        posts: user.posts((post) => ({ title: post.title })),
        profile: user.profile((profile) => ({ bio: profile.bio })),
      }))
      .toSQL().sql,
  ).toBe(
    classic()
      .users((user) => ({
        name: user.name,
        posts: user.posts((post) => ({ title: post.title })),
        profile: user.profile((profile) => ({ bio: profile.bio })),
      }))
      .toSQL().sql,
  );
  expect(
    database
      .comments((comment) => ({
        parent: comment.parent.body,
        replies: comment.children.count(),
      }))
      .toSQL().sql,
  ).toContain('LEFT JOIN "comments" AS');
});

const tagged = () => {
  const tags = table({ id: int.auto, label: text.unique, posts: many });
  const posts = table({
    id: int.auto,
    title: text,
    tags: many(tags.posts).with({ addedAt: timestamptz.now }),
  });

  return schema({ tags, posts }, { executor });
};

test("many(slot) creates the junction table", () => {
  const snapshot = tagged().$snapshot();
  const tags = table({ id: int.auto, label: text.unique });
  const posts = table({ id: int.auto, title: text });
  const explicit = schema(
    {
      tags,
      posts,
      postsTags: junction({
        posts: posts.onDelete.cascade,
        tags: tags.onDelete.cascade,
        addedAt: timestamptz.now,
      }),
    },
    { executor },
  ).$snapshot();
  const withoutRelations = (source: typeof snapshot) =>
    source.tables.map(({ relations: _relations, ...rest }) => rest);

  // The same tables, columns, keys and indexes as a junction() with cascade.
  expect(withoutRelations(snapshot)).toEqual(withoutRelations(explicit));
  expect(snapshotHash(migrationSnapshot(snapshot))).toBe(
    snapshotHash(migrationSnapshot(explicit)),
  );

  const junctionTable = snapshot.tables.find(
    (entry) => entry.name === "postsTags",
  )!;

  expect(junctionTable).toMatchObject({
    sqlName: "posts_tags",
    junction: true,
  });
  // The declaring table's key leads the primary key.
  expect(
    junctionTable.columns
      .filter((column) => column.primaryKey)
      .map((column) => column.sqlName),
  ).toEqual(["posts_id", "tags_id"]);
  expect(
    junctionTable.columns.map((column) => [
      column.sqlName,
      column.references?.table,
      column.references?.onDelete,
    ]),
  ).toEqual([
    ["posts_id", "posts", "cascade"],
    ["tags_id", "tags", "cascade"],
    ["added_at", undefined, undefined],
  ]);
  expect(junctionTable.indexes?.map((entry) => entry.sqlName)).toEqual([
    "posts_tags_tags_id_idx",
  ]);

  // Each side is named by its declaration.
  const relation = (name: string, key: string) =>
    snapshot.tables
      .find((entry) => entry.name === name)!
      .relations.find((entry) => entry.name === key);

  expect(relation("posts", "tags")).toEqual({
    name: "tags",
    kind: "through",
    target: "tags",
    junction: "postsTags",
    sourceForeignKey: "postsId",
    targetForeignKey: "tagsId",
  });
  expect(relation("tags", "posts")).toMatchObject({
    kind: "through",
    target: "posts",
    junction: "postsTags",
  });
  expect(
    tagged()
      .posts((post) => ({ tags: post.tags((tag) => ({ label: tag.label })) }))
      .toSQL().sql,
  ).toContain('"posts_tags"');
});

test("many(slot) options and link()", () => {
  const tags = table({ id: int.auto, label: text, posts: many });
  const posts = table({
    id: int.auto,
    title: text,
    tags: many(tags.posts).named("post_tag_links").restrict,
  });
  const named = schema({ tags, posts }, { executor })
    .$snapshot()
    .tables.find((entry) => entry.name === "postsTags")!;

  expect(named.sqlName).toBe("post_tag_links");
  expect(named.columns.map((column) => column.references?.onDelete)).toEqual([
    "restrict",
    "restrict",
  ]);

  const authors = table({ id: int.auto, name: text, books: many });
  const books = table({ id: int.auto, title: text, authors: many });
  const credits = link(authors.books, books.authors, { role: text });
  const library = schema({ authors, books, credits }, { executor });
  const linked = library
    .$snapshot()
    .tables.find((entry) => entry.name === "credits")!;

  expect(
    linked.columns.map((column) => [
      column.name,
      column.references?.table,
      column.references?.onDelete,
    ]),
  ).toEqual([
    ["authorsId", "authors", "cascade"],
    ["booksId", "books", "cascade"],
    ["role", undefined, undefined],
  ]);
  expect(
    library.authors((author) => ({ books: author.books.count() })).toSQL().sql,
  ).toContain('"credits"');

  // Named references: junction() with cascade unless a side says otherwise.
  const people = table({ id: int.auto, name: text });
  const teams = table({ id: int.auto, title: text });
  const members = schema(
    {
      people,
      teams,
      members: link({ person: people, team: teams.onDelete.restrict }),
    },
    { executor },
  )
    .$snapshot()
    .tables.find((entry) => entry.name === "members")!;

  expect(members.columns.map((column) => column.references?.onDelete)).toEqual([
    "cascade",
    "restrict",
  ]);
});

test("plain records and schema callbacks take slots too", () => {
  const database = schema(
    {
      users: { id: int.auto, name: text, posts: many.cascade },
      posts: ({ users }) => table({ id: int.auto, author: maybe(users) }),
    },
    { executor },
  );
  const author = database
    .$snapshot()
    .tables.find((entry) => entry.name === "posts")!.columns[1]!;

  expect(author).toMatchObject({
    name: "authorId",
    notNull: false,
    references: { table: "users", onDelete: "cascade" },
  });
});

test("slot mistakes are reported with the fix", () => {
  // The types reject most of these as well; the messages are for untyped code.
  const broken = (definitions: unknown) =>
    schema(definitions as never, { executor });

  const owners = () => table({ id: int.auto, name: text, pets: many });

  expect(() => broken({ owners: owners() })).toThrow(
    'symmetria: slot "owners.pets" is never claimed; the table on the other side declares it: one(owners.pets), maybe(owners.pets) or many(owners.pets)',
  );
  expect(() => {
    const parent = owners();

    broken({
      owners: parent,
      pets: table({
        id: int.auto,
        owner: one(parent.pets),
        keeper: one(parent.pets),
      }),
    });
  }).toThrow('duplicate inverse "owners.pets"');
  expect(() => table({ id: int.auto, index: many })).toThrow(
    'symmetria: a slot cannot be named "index": every table has .index of its own; choose another name',
  );
  expect(() => one((owners() as unknown as { nope: never }).nope)).toThrow(
    "symmetria: one() expects a table or a slot such as users.posts (got undefined: no such slot on that table)",
  );
  expect(() => maybe(owners().name as never)).toThrow(
    'got the column "name"; a slot is declared as name: many',
  );
  expect(() => many(table({ id: int.auto, x: one }).x as never)).not.toThrow();
  expect(() => {
    const parent = table({ id: int.auto, name: text, pet: one });

    broken({
      owners: parent,
      pets: table({ id: int.auto, owners: many(parent.pet as never) }),
    });
  }).toThrow('needs a many slot; "owners.pet" is declared as one');
  expect(() => {
    const parent = table({ id: int.auto, name: text, pets: many.setNull });

    broken({
      owners: parent,
      pets: table({ id: int.auto, owner: one(parent.pets) }),
    });
  }).toThrow(
    'symmetria: slot "owners.pets" is setNull, so "pets.owner" must be optional: maybe(owners.pets)',
  );
  expect(() => {
    const parent = table({ id: int.auto, name: text, pets: many.cascade });

    broken({
      owners: parent,
      pets: table({ id: int.auto, owner: one(parent.pets).restrict }),
    });
  }).toThrow("both say what a delete does (cascade and restrict)");
  expect(() => {
    const parent = table({ id: int.auto, name: text, pet: one });

    broken({
      owners: parent,
      pets: table({ id: int.auto, owner: parent.inverse("pet") }),
    });
  }).toThrow(
    'symmetria: slot "owners.pet" is one, so "pets.owner" must be unique; write one(owners.pet) or add .unique',
  );
  expect(() =>
    broken({
      nodes: table({
        id: int.auto,
        parent: maybe(self.kids),
        children: many,
      }),
    }),
  ).toThrow(
    'symmetria: "nodes.parent" claims self.kids, but "nodes" declares no such slot; add kids: many',
  );
  expect(() =>
    junction({ a: owners(), b: owners(), rows: many } as never),
  ).toThrow("a junction table holds two references and columns");
  expect(() => {
    const tags = table({ id: int.auto, label: text, posts: many });

    broken({
      tags,
      posts: table({ id: int.auto, tags: many(tags.posts) }),
      postsTags: table({ id: int.auto }),
    });
  }).toThrow(
    'symmetria: the junction table of "posts.tags" is "postsTags", a name this schema already uses; declare the junction yourself with link()',
  );
});

test("declarations with slots stay reusable across schemas", () => {
  const users = table({ id: int.auto, name: text, posts: many });
  const posts = table({ id: int.auto, author: one(users.posts) });
  const first = schema({ users, posts }, { executor }).$snapshot();
  const second = schema({ users, posts }, { executor }).$snapshot();

  expect(second).toEqual(first);
  // Chained declarations keep their slots.
  const indexed = users.named("people");

  expect(
    schema(
      {
        users: indexed,
        posts: table({ id: int.auto, author: one(indexed.posts) }),
      },
      { executor },
    )
      .$snapshot()
      .tables.find((entry) => entry.name === "users")!.sqlName,
  ).toBe("people");
});
