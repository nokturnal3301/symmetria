/**
 * Golden SQL: builds a wide variety of statements on one schema and records
 * the SQL text and parameters of each, so a structural refactor of the runtime
 * can be checked for byte-identical output.
 */
import {
  and,
  bigint,
  bool,
  coalesce,
  count,
  dateTrunc,
  exists,
  index,
  int,
  jsonb,
  junction,
  lag,
  lead,
  maximum,
  not,
  numeric,
  oneOf,
  or,
  over,
  prepare,
  rank,
  rowNumber,
  schema,
  searchDocument,
  sql,
  sum,
  table,
  text,
  timestamptz,
  tsvector,
  when,
  type CompiledQuery,
  type Page,
  type PageCursor,
  type PageOptions,
  type SelectedColumn,
} from "../../../../packages/runtime/src";
import type {
  Driver,
  TransactionDriver,
} from "../../../../packages/runtime/src/entries/pg";

type Statement = { sql: string; parameters: unknown[] };
export type GoldenEntry =
  | Statement
  | { error: string }
  | { statements: Statement[]; error?: string };

/** Parameters as JSON: bigint, Date and bytes have no JSON form of their own. */
const plain = (value: unknown): unknown => {
  if (typeof value === "bigint") {
    return { bigint: value.toString() };
  }

  if (value instanceof Date) {
    return { date: value.toISOString() };
  }

  if (value instanceof Uint8Array) {
    return { bytes: Buffer.from(value).toString("hex") };
  }

  if (Array.isArray(value)) {
    return value.map(plain);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, plain(entry)]),
    );
  }

  return value === undefined ? { undefined: true } : value;
};

const statement = (query: CompiledQuery): Statement => ({
  sql: query.sql,
  parameters: query.parameters.map(plain),
});

type Settings = {
  theme: "dark" | "light";
  notifications: { email: boolean; sms?: boolean };
  tags: string[];
  note: string | null;
};

const tables = () => {
  const tenants = table({ code: text, title: text }).primaryKey((tenants) => [
    tenants.code,
  ]);
  const users = table({
    id: int.auto,
    email: text.unique,
    name: text,
    active: bool.default(true),
    visits: int.default(0),
    balance: numeric(20, 2).default("0"),
    settings: jsonb<Settings>().nullable,
    tenant: tenants.nullable,
    createdAt: timestamptz.now,
  });
  const posts = table({
    id: int.auto,
    slug: text.unique,
    title: text,
    body: text.default(""),
    author: users,
    editor: users.nullable.inverse("edited"),
    views: bigint.default(0n),
    metadata: jsonb<{ tags: string[]; rating: number }>().nullable,
    document: tsvector.nullable,
    status: oneOf("draft", "published").default("draft"),
    labels: text.array.nullable,
    createdAt: timestamptz.now,
  }).indexes((posts) => ({
    search: index(
      searchDocument(
        { A: posts.title, B: posts.body },
        { language: "english" },
      ),
    ).using("gin"),
    published: index(posts.createdAt.descending).where(
      and(posts.status.is("published"), posts.views.between(1n, 100n)),
    ),
  }));
  const comments = table({
    id: int.auto,
    post: posts,
    author: users,
    body: text,
    score: int.default(0),
  })
    .checks((comments) => ({
      score: comments.score.between(0, 10),
      body: or(comments.body.isNot(""), comments.score.in([1, 2])),
    }))
    .indexes((comments) => ({
      best: index(comments.postId, comments.score.descending).where(
        not(comments.score.below(5)),
      ),
    }));
  const tags = table({ id: int.auto, label: text.unique });
  const postTags = junction({ post: posts, tag: tags });
  const profiles = table({ id: int.auto, user: users.unique, bio: text });
  // The key lists its columns in another order than they are declared in.
  const records = table({
    tenant: tenants,
    externalId: text,
    title: text,
    amount: int.default(0),
  }).primaryKey((records) => [records.externalId, records.tenantId]);
  const groups = table({ id: int.auto, name: text.unique });
  const memberships = table({
    user: users,
    group: groups,
    role: text.default("member"),
  }).primaryKey((memberships) => [memberships.groupId, memberships.userId]);
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
  const aliases = table({ id: int.auto, handle: handles, label: text });
  const notes = table({
    id: int.auto,
    recordTenant: text,
    recordExternalId: text,
    authorEmail: text,
    body: text,
  }).relations((note, { to }) => ({
    record: to(records).one((record) =>
      and(
        note.recordTenant.is(record.tenantId),
        note.recordExternalId.is(record.externalId),
      ),
    ),
    author: to(users)
      .one((user) => note.authorEmail.is(user.email))
      .inverse("notes"),
    membership: to(memberships).one((membership) =>
      membership.role.is(note.body),
    ),
  }));
  const entries = table({
    id: int,
    team: text,
    parentId: int.nullable,
    amount: bigint,
  });

  return {
    tenants,
    users,
    posts,
    comments,
    tags,
    postTags,
    profiles,
    records,
    groups,
    memberships,
    handles,
    aliases,
    notes,
    entries,
  };
};

/** A value of a type the column of that name decodes. */
const sample = (name: string, position: number): unknown =>
  name.startsWith("__symmetria_cursor")
    ? String(position + 1)
    : /^(id|count|present|amount|score|visits|views|position)$|Id$/.test(name)
      ? position + 1
      : /At$/.test(name)
        ? "2026-01-01T00:00:00.000Z"
        : name === "active"
          ? true
          : name === "balance"
            ? "1.00"
            : ["settings", "metadata", "document", "labels"].includes(name)
              ? null
              : `v${position + 1}`;

/** Rows answering any statement: every output name it mentions, with a value of a fitting type. */
const answer = (
  query: CompiledQuery,
  rows: number,
): Record<string, unknown>[] =>
  Array.from({ length: rows }, (_, position) => {
    const row: Record<string, unknown> = {};

    for (const [, name] of query.sql.matchAll(/AS "([A-Za-z0-9_]+)"/g)) {
      row[name!] = sample(name!, position);
    }

    // Nested inserts read the written row back as one JSON object.
    if (query.sql.includes("RETURNING json_build_object(")) {
      row.row = Object.fromEntries(
        [...query.sql.matchAll(/'([A-Za-z0-9_]+)', /g)].map(([, name]) => [
          name!,
          sample(name!, position),
        ]),
      );
    }

    return row;
  });

export const collectGolden = async (): Promise<Record<string, GoldenEntry>> => {
  const golden: Record<string, GoldenEntry> = {};
  const log: Statement[] = [];
  let rows = 1;
  const execute = async (query: CompiledQuery) => {
    log.push(statement(query));

    return answer(query, rows);
  };
  const connection: TransactionDriver = {
    execute,
    transaction: (callback) => callback(connection),
  };
  const driver: Driver = {
    execute,
    close: async () => {},
    transaction: (callback) => callback(connection),
  };
  const declared = tables();
  const model = schema(
    {
      ...declared,
      categories: ({ categories }) => ({
        id: int.auto,
        name: text,
        parent: categories.nullable.inverse("children"),
      }),
    },
    { driver },
  );
  const tableNames = [...Object.keys(declared), "categories"] as (
    | keyof typeof declared
    | "categories"
  )[];
  const scoped = model.$scope({
    posts: (posts) => posts.authorId.is(7),
    users: (users) => users.active.is(true),
    records: (records) => records.tenantId.is("acme"),
  });

  const add = (name: string, entry: GoldenEntry) => {
    if (Object.hasOwn(golden, name)) {
      throw new Error(`duplicate golden case "${name}"`);
    }

    golden[name] = entry;
  };
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

  /** The statement a query compiles to. */
  const compiled = (
    name: string,
    build: () => CompiledQuery | { toSQL: () => CompiledQuery },
  ) => {
    try {
      const query = build();

      add(name, statement("toSQL" in query ? query.toSQL() : query));
    } catch (error) {
      add(name, { error: message(error) });
    }
  };
  /** Every statement an operation sends, in order. */
  const sent = async (
    name: string,
    run: () => PromiseLike<unknown>,
    answers = 1,
  ) => {
    log.length = 0;
    rows = answers;

    try {
      await run();
      add(name, { statements: [...log] });
    } catch (error) {
      add(name, { statements: [...log], error: message(error) });
    } finally {
      rows = 1;
    }
  };
  /** The message an invalid schema or query fails with. */
  const failure = async (name: string, run: () => unknown) => {
    try {
      const result = run();
      const outcome =
        result &&
        typeof result === "object" &&
        "toSQL" in result &&
        typeof result.toSQL === "function"
          ? result.toSQL()
          : await result;

      add(name, { error: `(no error: ${typeof outcome})` });
    } catch (error) {
      add(name, { error: message(error) });
    }
  };

  // -- selections and automatic paths ---------------------------------------
  compiled("select/columns", () =>
    model.users((users) => ({ id: users.id, name: users.name })),
  );
  compiled("select/all-columns", () =>
    model.records((records) => ({
      tenantId: records.tenantId,
      externalId: records.externalId,
      title: records.title,
      amount: records.amount,
    })),
  );
  compiled("select/paths", () =>
    model.posts(
      (posts) => ({
        title: posts.title,
        author: posts.author.name,
        tenant: posts.author.tenant.title,
        editor: posts.editor.name,
        editorTenant: posts.editor.tenant.title,
      }),
      {
        where: (posts) => [
          posts.author.name.is("Ada"),
          or(posts.views.above(10n), posts.editorId.is(null)),
          not(posts.title.like("draft%")),
          posts.id.in([1, 2, 3]),
          posts.id.notIn([]),
          posts.views.between(1, 100),
        ],
        orderBy: (posts) => [
          posts.author.name.ascending.nullsLast,
          posts.id.descending,
        ],
        limit: 10,
        offset: 20,
      },
    ),
  );
  compiled("select/explicit-joins", () =>
    model.posts((posts, { innerJoin, leftJoin }) => {
      const reviewer = innerJoin(model.users.as("reviewer"), (reviewer) =>
        posts.editorId.is(reviewer.id),
      );
      const writer = leftJoin(posts.author.as("writer"));
      const other = leftJoin(writer.posts.as("otherPosts"));

      return {
        title: posts.title,
        reviewer: reviewer.name,
        writer: writer.name,
        otherId: other.id,
      };
    }),
  );
  compiled("select/self-reference", () =>
    model.categories((categories) => ({
      name: categories.name,
      grandparent: categories.parent.parent.name,
      children: categories.children((children) => ({
        name: children.name,
        grandchildren: children.children((children) => ({
          name: children.name,
        })),
      })),
    })),
  );
  compiled("select/reverse-one-path", () =>
    model.users((users) => ({ bio: users.profiles.bio })),
  );
  compiled("select/group-having-distinct", () =>
    model.posts(
      (posts, { innerJoin }) => {
        const author = innerJoin(posts.author);

        return {
          name: author.name,
          posts: count().as("posts"),
          views: sum(posts.views),
          latest: maximum(posts.createdAt),
        };
      },
      {
        groupBy: (posts) => [posts.author.name],
        having: () => count().above(1),
        orderBy: (posts) => posts.author.name.ascending,
        distinct: true,
      },
    ),
  );
  compiled("select/case-coalesce-arithmetic", () =>
    model.users((users) => ({
      label: coalesce(users.tenantId, "none"),
      doubled: users.visits.multiply(2).plus(1),
      share: users.balance.divide(3),
      raw: sql<string>`concat(${"Hello "}::text, ${users.name})`,
    })),
  );
  compiled("select/for-update", () =>
    model.users((users) => ({ id: users.id }), {
      where: (users) => users.id.is(1),
      forUpdate: true,
    }),
  );

  // -- nested relations ------------------------------------------------------
  compiled("nested/three-levels", () =>
    model.users(
      (users) => ({
        name: users.name,
        posts: users.posts(
          (posts) => ({
            title: posts.title,
            author: posts.author.name,
            comments: posts.comments(
              (comments) => ({
                body: comments.body,
                author: comments.author((author) => ({
                  name: author.name,
                  profile: author.profiles((profile) => ({
                    bio: profile.bio,
                  })),
                })),
              }),
              {
                where: (comments) => comments.score.above(0),
                orderBy: (comments) => comments.score.descending,
                limit: 2,
              },
            ),
            tags: posts.tags((tags) => ({ label: tags.label }), {
              orderBy: (tags) => tags.label.ascending,
            }),
          }),
          {
            where: (posts) => posts.views.above(1n),
            orderBy: (posts) => [
              posts.createdAt.descending,
              posts.id.descending,
            ],
            limit: 3,
            offset: 1,
          },
        ),
        edited: users.edited((posts) => ({ id: posts.id })),
      }),
      {
        where: (users) => users.id.above(10),
        orderBy: (users) => users.id.ascending,
        limit: 50,
        offset: 100,
      },
    ),
  );
  compiled("nested/many-to-many-both-sides", () =>
    model.tags((tags) => ({
      label: tags.label,
      posts: tags.posts(
        (posts) => ({
          title: posts.title,
          tags: posts.tags((tags) => ({ id: tags.id })),
        }),
        { limit: 5 },
      ),
    })),
  );
  compiled("nested/forward-object", () =>
    model.comments((comments) => ({
      body: comments.body,
      post: comments.post((post) => ({
        title: post.title,
        author: post.author((author) => ({ name: author.name })),
      })),
    })),
  );
  compiled("nested/composite-parent", () =>
    model.tenants((tenants) => ({
      code: tenants.code,
      records: tenants.records(
        (records) => ({
          externalId: records.externalId,
          tenant: records.tenant((tenant) => ({ title: tenant.title })),
        }),
        { orderBy: (records) => records.externalId.ascending, limit: 2 },
      ),
    })),
  );
  compiled("nested/scoped", () =>
    scoped.users((users) => ({
      name: users.name,
      posts: users.posts((posts) => ({
        title: posts.title,
        author: posts.author.name,
      })),
      total: users.posts.count(),
    })),
  );

  // -- relation aggregates ---------------------------------------------------
  compiled("aggregates/relation", () =>
    model.users(
      (users) => ({
        id: users.id,
        posts: users.posts.count(),
        views: users.posts.sum((posts) => posts.views),
        latest: users.posts.maximum((posts) => posts.createdAt),
        average: users.comments.average((comments) => comments.score),
        first: users.comments.minimum((comments) => comments.id),
        any: users.edited.exists(),
        paged: users.posts({ limit: 2, offset: 1 }).count(),
        none: users.posts({ limit: 0 }).exists(),
      }),
      {
        where: (users) => [
          users.posts.count().above(2),
          users.posts.sum((posts) => posts.views).above(10 as never),
        ],
        orderBy: (users) => users.posts.count().descending,
      },
    ),
  );
  compiled("aggregates/nested", () =>
    model.users((users) => ({
      id: users.id,
      posts: users.posts((posts) => ({
        title: posts.title,
        comments: posts.comments.count(),
        best: posts.comments.maximum((comments) => comments.score),
        tags: posts.tags.count(),
      })),
    })),
  );
  compiled("aggregates/quantifiers", () =>
    model.users((users) => ({ id: users.id }), {
      where: (users) => [
        users.posts.some((posts) =>
          posts.tags.none((tags) => tags.label.is("hidden")),
        ),
        users.posts.every((posts) => posts.editor.name.is("Ada")),
        users.comments.some(),
      ],
    }),
  );
  compiled("aggregates/shared", () =>
    model.users((users) => ({ id: users.id, total: users.posts.count() }), {
      where: (users) => users.posts.count().above(1),
      orderBy: (users) => users.posts.count().descending,
      limit: 5,
    }),
  );
  compiled("aggregates/root-first-pagination", () =>
    model.users(
      (users) => ({
        id: users.id,
        total: users.posts.count(),
        posts: users.posts((posts) => ({ id: posts.id })),
      }),
      { orderBy: (users) => users.id.ascending, limit: 5, offset: 5 },
    ),
  );

  // -- condition relations ---------------------------------------------------
  compiled("conditions/one-path", () =>
    model.notes((notes) => ({
      body: notes.body,
      record: notes.record.title,
      author: notes.author.name,
      role: notes.membership.role,
    })),
  );
  compiled("conditions/one-nested", () =>
    model.notes((notes) => ({
      record: notes.record((record) => ({
        title: record.title,
        tenant: record.tenant.title,
      })),
      membership: notes.membership((membership) => ({
        role: membership.role,
      })),
    })),
  );
  compiled("conditions/one-join", () =>
    model.notes((notes, { innerJoin }) => {
      const record = innerJoin(notes.record.as("record"));

      return { body: notes.body, title: record.title };
    }),
  );
  compiled("conditions/inverse-many", () =>
    model.users(
      (users) => ({
        name: users.name,
        notes: users.notes((notes) => ({ body: notes.body })),
        total: users.notes.count(),
      }),
      {
        where: (users) => users.notes.some((notes) => notes.body.is("x")),
      },
    ),
  );
  compiled("conditions/scoped-one", () =>
    scoped.notes((notes) => ({
      record: notes.record.title,
      author: notes.author.name,
    })),
  );
  compiled("conditions/where-through-one", () =>
    model.notes((notes) => ({ id: notes.id }), {
      where: (notes) => notes.record.amount.above(1),
    }),
  );

  // -- key lookups -----------------------------------------------------------
  compiled("byId/single", () => model.users.byId(7));
  compiled("byId/single-text", () => model.tenants.byId("acme"));
  compiled("byId/composite-out-of-order", () =>
    model.records.byId({ tenantId: "acme", externalId: "r1" }),
  );
  compiled("byId/composite-out-of-order-shaped", () =>
    model.records.byId({ externalId: "r1", tenantId: "acme" })((records) => ({
      title: records.title,
      tenant: records.tenant.title,
    })),
  );
  compiled("byId/composite-references", () =>
    model.memberships.byId({ userId: 1, groupId: 2 }),
  );
  compiled("byId/junction", () => model.postTags.byId({ postId: 1, tagId: 2 }));
  compiled("byId/scoped", () => scoped.posts.byId(3));
  compiled("byId/scoped-composite", () =>
    scoped.records.byId({ tenantId: "acme", externalId: "r1" }),
  );
  compiled("byId/update", () => model.users.byId(7).update({ name: "Ada" }));
  compiled("byId/composite-update", () =>
    model.records
      .byId({ tenantId: "acme", externalId: "r1" })
      .update((records) => ({ amount: records.amount.plus(1) }))
      .returning((records) => ({ amount: records.amount })),
  );
  compiled("byId/composite-delete", () =>
    model.memberships.byId({ userId: 1, groupId: 2 }).delete(),
  );
  compiled("byId/junction-delete", () =>
    model.postTags.byId({ postId: 1, tagId: 2 }).delete(),
  );
  compiled("byId/scoped-update", () =>
    scoped.posts.byId(1).update({ title: "x" }),
  );
  compiled("by/unique-column", () =>
    model.users.by.email("ada@example.com")((users) => ({
      id: users.id,
      name: users.name,
    })),
  );
  compiled("by/unique-column-update", () =>
    model.users.by
      .email("ada@example.com")
      .update({ name: "Ada" })
      .returning((users) => [users.id]),
  );
  compiled("by/unique-column-delete", () =>
    model.posts.by.slug("first").delete(),
  );
  compiled("by/unique-index", () =>
    model.handles.by.identity({ tenant: "one", handle: "ada" }),
  );
  compiled("by/unique-index-update", () =>
    model.handles.by
      .identity({ handle: "ada", tenant: "one" })
      .update({ active: 0 }),
  );
  compiled("by/unique-index-delete", () =>
    model.handles.by.identity({ tenant: "one", handle: "ada" }).delete(),
  );
  compiled("by/unique-reference", () => model.profiles.by.userId(1));
  compiled("by/scoped", () => scoped.users.by.email("ada@example.com"));
  add("by/names", {
    sql: JSON.stringify(
      Object.fromEntries(
        tableNames.map((name) => [name, Object.keys(model[name].by)]),
      ),
    ),
    parameters: [],
  });

  // -- writes ----------------------------------------------------------------
  compiled("insert/bulk-returning", () =>
    model.posts
      .insert([
        {
          slug: "a",
          title: "first",
          authorId: 3,
          views: 9007199254740993n,
          metadata: { tags: ["sql"], rating: 1 },
        },
        { slug: "b", title: "second", authorId: 3 },
      ])
      .returning((posts) => [posts.id, posts.title]),
  );
  compiled("insert/returning-projection", () =>
    model.users.insert({ email: "a", name: "Ada" }).returning((users) => ({
      id: users.id,
      upper: sql<string>`upper(${users.name})`,
      visits: users.visits.plus(1),
    })),
  );
  compiled("insert/scoped", () =>
    scoped.posts
      .insert({ slug: "a", title: "x", authorId: 7 })
      .returning((posts) => ({ id: posts.id })),
  );
  compiled("update/expression", () =>
    model.users
      .update((users) => ({ visits: users.visits.plus(1), name: "Ada" }))
      .where((users) => users.id.is(7))
      .returning((users) => [users.visits]),
  );
  compiled("update/relation-path", () =>
    model.posts
      .update({ title: "x" })
      .where((posts) => posts.author.name.is("Ada")),
  );
  compiled("update/relation-path-composite-out-of-order", () =>
    model.records
      .update({ title: "x" })
      .where((records) => records.tenant.title.is("Acme")),
  );
  compiled("update/relation-path-composite-references", () =>
    model.memberships
      .update({ role: "owner" })
      .where((memberships) => [
        memberships.user.name.is("Ada"),
        memberships.group.name.is("core"),
      ]),
  );
  compiled("update/relation-path-junction", () =>
    model.postTags
      .update({ tagId: 2 })
      .where((postTags) => postTags.post.title.is("x")),
  );
  compiled("update/relation-path-scoped", () =>
    scoped.records
      .update({ title: "x" })
      .where((records) => records.tenant.title.is("Acme")),
  );
  compiled("update/quantifier", () =>
    model.users
      .update({ active: false })
      .where((users) => users.posts.some((posts) => posts.views.above(10))),
  );
  compiled("update/all", () => model.users.update({ active: false }).all());
  compiled("delete/relation-path", () =>
    model.posts.delete().where((posts) => posts.author.name.is("Ada")),
  );
  compiled("delete/relation-path-composite-out-of-order", () =>
    model.records
      .delete()
      .where((records) => [
        records.tenant.title.is("Acme"),
        records.amount.above(1),
      ])
      .returning((records) => [records.externalId]),
  );
  compiled("delete/relation-path-composite-references", () =>
    model.memberships
      .delete()
      .where((memberships) => memberships.group.name.is("core")),
  );
  compiled("delete/relation-path-junction", () =>
    model.postTags
      .delete()
      .where((postTags) => postTags.tag.label.is("hidden")),
  );
  compiled("delete/condition-path", () =>
    model.notes.delete().where((notes) => notes.record.amount.is(0)),
  );
  compiled("delete/scoped", () => scoped.posts.delete());
  compiled("upsert/do-update-where", () =>
    model.users
      .insert({ email: "a", name: "Ada" })
      .onConflict("email")
      .doUpdate(
        (users, excluded) => ({
          name: excluded.name,
          visits: users.visits.plus(1),
        }),
        {
          where: (current, incoming) => incoming.visits.above(current.visits),
        },
      )
      .returning((users) => [users.id, users.visits]),
  );
  compiled("upsert/do-update-names", () =>
    model.records
      .insert({ tenantId: "acme", externalId: "r1", title: "t" })
      .onConflict("externalId", "tenantId")
      .doUpdate("title"),
  );
  compiled("upsert/do-nothing", () =>
    model.users.insert({ email: "a", name: "Ada" }).onConflict().doNothing(),
  );
  compiled("upsert/scoped-do-update-where", () =>
    scoped.posts
      .insert({ slug: "a", title: "x", authorId: 7 })
      .onConflict("slug")
      .doUpdate(
        { title: "y" },
        {
          where: (current, incoming) => incoming.views.above(current.views),
        },
      ),
  );

  // -- nested inserts --------------------------------------------------------
  await sent("nested-insert/create-forward-and-many", () =>
    model.posts
      .insert({
        slug: "first",
        title: "First",
        author: { create: { email: "ada", name: "Ada" } },
        comments: {
          create: [
            { body: "one", authorId: 1 },
            { body: "two", authorId: 2 },
          ],
        },
      })
      .returning((posts) => ({ id: posts.id, authorId: posts.authorId }))
      .execute(),
  );
  await sent("nested-insert/connect-forward", () =>
    model.posts
      .insert({ slug: "s", title: "t", author: { connect: 1 } })
      .execute(),
  );
  await sent("nested-insert/connect-forward-unique", () =>
    model.posts
      .insert({ slug: "s", title: "t", author: { connect: { email: "ada" } } })
      .execute(),
  );
  await sent("nested-insert/connect-or-create-forward", () =>
    model.posts
      .insert({
        slug: "s",
        title: "t",
        author: { connectOrCreate: { email: "ada", name: "Ada" } },
      })
      .execute(),
  );
  await sent("nested-insert/many-to-many", () =>
    model.posts
      .insert({
        slug: "s",
        title: "t",
        authorId: 1,
        tags: {
          create: [{ label: "new" }],
          connect: [1, { label: "known" }],
          connectOrCreate: [{ label: "bun" }, { label: "postgres" }],
        },
      })
      .execute(),
  );
  await sent("nested-insert/reverse-connect", () =>
    model.users
      .insert({
        email: "a",
        name: "Ada",
        posts: { connect: [1, { slug: "known" }] },
        profiles: { create: { bio: "hi" } },
      })
      .execute(),
  );
  await sent("nested-insert/reverse-connect-composite-out-of-order", () =>
    model.tenants
      .insert({
        code: "acme",
        title: "Acme",
        records: {
          connect: [{ tenantId: "other", externalId: "r1" }],
          create: [{ externalId: "r2", title: "t" }],
        },
      })
      .execute(),
  );
  await sent("nested-insert/reverse-connect-composite-references", () =>
    model.groups
      .insert({
        name: "core",
        memberships: {
          connect: [{ userId: 1, groupId: 9 }],
          create: [{ userId: 2 }],
        },
      })
      .execute(),
  );
  await sent("nested-insert/reverse-connect-or-create-composite", () =>
    model.tenants
      .insert({
        code: "acme",
        title: "Acme",
        records: { connectOrCreate: [{ externalId: "r3", title: "t" }] },
      })
      .execute(),
  );
  await sent("nested-insert/reverse-connect-or-create-references", () =>
    model.groups
      .insert({
        name: "core",
        memberships: { connectOrCreate: [{ userId: 3, role: "owner" }] },
      })
      .execute(),
  );
  await sent("nested-insert/deep", () =>
    model.users
      .insert({
        email: "a",
        name: "Ada",
        tenant: { connectOrCreate: { code: "acme", title: "Acme" } },
        posts: {
          create: [
            {
              slug: "p",
              title: "P",
              tags: { connectOrCreate: [{ label: "x" }] },
              comments: {
                create: [{ body: "c", author: { connect: { email: "bob" } } }],
              },
            },
          ],
        },
      })
      .returning((users) => ({ id: users.id }))
      .execute(),
  );
  await sent("nested-insert/bulk", () =>
    model.posts
      .insert([
        { slug: "a", title: "A", author: { connect: 1 } },
        {
          slug: "b",
          title: "B",
          author: { create: { email: "b", name: "B" } },
        },
      ])
      .execute(),
  );
  await sent("nested-insert/self-reference", () =>
    model.categories
      .insert({
        name: "root",
        children: { create: [{ name: "leaf" }], connect: [5] },
        parent: { connect: 1 },
      })
      .execute(),
  );
  await sent("nested-insert/connect-unique-index", () =>
    model.aliases
      .insert({
        label: "a",
        handle: { connect: { handle: "ada", tenant: "one" } },
      })
      .execute(),
  );
  await sent("nested-insert/connect-or-create-unique-index", () =>
    model.aliases
      .insert({
        label: "a",
        handle: {
          connectOrCreate: { tenant: "one", handle: "ada", active: 1 },
        },
      })
      .execute(),
  );
  await sent("nested-insert/connect-partial-index", () =>
    model.aliases
      .insert({ label: "a", handle: { connect: { handle: "ada" } as never } })
      .execute(),
  );
  await sent("nested-insert/missing-connect", () =>
    model.posts
      .insert({
        slug: "s",
        title: "t",
        author: { connect: { name: "Ada" } as never },
      })
      .execute(),
  );
  await sent(
    "nested-insert/connect-not-found",
    () =>
      model.posts
        .insert({ slug: "s", title: "t", author: { connect: 1 } })
        .execute(),
    0,
  );
  await sent("nested-insert/condition-relation", () =>
    model.notes
      .insert({
        recordTenant: "a",
        recordExternalId: "b",
        authorEmail: "c",
        body: "d",
        author: { connect: 1 },
      } as never)
      .execute(),
  );

  // -- CTEs ------------------------------------------------------------------
  const ranked = model
    .entries(
      (entries) => ({
        id: entries.id,
        amount: entries.amount,
        position: rowNumber().over({
          partitionBy: [entries.team],
          orderBy: [entries.amount.descending, entries.id.ascending],
        }),
      }),
      { where: (entries) => entries.team.is("A") },
    )
    .cte("ranked", { materialized: false });

  compiled("cte/plain", () =>
    ranked((ranked) => ({ id: ranked.id, position: ranked.position }), {
      where: (ranked) => ranked.position.atMost(2),
    }),
  );
  compiled("cte/dependencies", () => {
    const first = model.entries((entries) => ({ id: entries.id })).cte("first");
    const second = first((first) => ({ id: first.id })).cte("second", {
      materialized: true,
    });

    return second((second, { innerJoin }) => {
      innerJoin(first, (row) => second.id.is(row.id));

      return { id: second.id };
    });
  });
  compiled("cte/in-subqueries", () => {
    const leaders = model
      .entries((entries) => ({ id: entries.id }), {
        where: (entries) => entries.amount.above(100n),
      })
      .cte("leaders");
    const teams = model
      .entries((entries) => ({ team: entries.team }), {
        where: (entries) => entries.parentId.is(null),
      })
      .cte("teams");

    return model.entries(
      (entries) => ({
        id: entries.id,
        leader: leaders((leader) => ({ id: maximum(leader.id) })).scalar(),
        relative: coalesce(
          lag(entries.amount).over({ orderBy: entries.id.ascending }),
          0n,
        ),
      }),
      {
        where: (entries) => [
          entries.id.in(leaders((leader) => ({ id: leader.id }))),
          exists(
            teams((team) => ({ team: team.team }), {
              where: (team) => team.team.is(entries.team),
            }),
          ),
          entries.amount.between(
            1n,
            leaders((leader) => ({ id: maximum(leader.id) })).scalar() as never,
          ),
        ],
      },
    );
  });
  compiled("cte/recursive", () =>
    prepare({ rootId: int }, (parameters) =>
      model
        .entries(
          (entries) => ({
            id: entries.id,
            amount: entries.amount,
            depth: sql.of(int)`0`,
          }),
          { where: (entries) => entries.id.is(parameters.rootId) },
        )
        .recursive("tree", (tree) =>
          model.entries((entries, { innerJoin }) => {
            const row = innerJoin(tree, (row) => entries.parentId.is(row.id));

            return {
              id: entries.id,
              amount: entries.amount,
              depth: row.depth.plus(1),
            };
          }),
        )((tree) => ({ id: tree.id, depth: tree.depth }), {
        orderBy: (tree) => tree.id.ascending,
      }),
    ).toSQL({ rootId: 1 }),
  );
  compiled("cte/recursive-union", () =>
    model
      .entries((entries) => ({ id: entries.id }), {
        orderBy: (entries) => entries.id.ascending,
        limit: 1,
      })
      .recursive(
        "sequence",
        (sequence) =>
          sequence((sequence) => ({ id: sequence.id.plus(1) }), {
            where: (sequence) => sequence.id.below(3),
          }),
        { unionAll: false },
      )((sequence) => ({ id: sequence.id })),
  );
  compiled("cte/upsert-condition", () => {
    const leaders = model
      .entries((entries) => ({ id: entries.id }), {
        where: (entries) => entries.amount.above(100n),
      })
      .cte("leaders");

    return model.entries
      .insert({ id: 1, team: "A", amount: 5n })
      .onConflict("id")
      .doUpdate(
        { amount: 6n },
        {
          where: (current) =>
            current.id.in(leaders((leader) => ({ id: leader.id }))),
        },
      );
  });
  compiled("cte/update-where", () => {
    const leaders = model
      .entries((entries) => ({ id: entries.id }))
      .cte("leaders");

    return model.entries
      .update({ team: "B" })
      .where((entries) =>
        entries.id.in(leaders((leader) => ({ id: leader.id }))),
      );
  });
  compiled("cte/derived-and-nested", () => {
    const busy = model
      .users((users) => ({ id: users.id, total: users.posts.count() }))
      .cte("busy");
    const recent = model
      .posts((posts) => ({ authorId: posts.authorId }), {
        where: (posts) => posts.views.above(9n),
      })
      .as("recent");

    return busy((busy, { innerJoin }) => {
      const row = innerJoin(recent, (row) => busy.id.is(row.authorId));

      return { id: busy.id, total: busy.total, authorId: row.authorId };
    });
  });

  // -- windows ---------------------------------------------------------------
  compiled("window/functions", () =>
    model.entries((entries) => ({
      id: entries.id,
      position: rowNumber().over({
        partitionBy: [entries.team],
        orderBy: entries.id.ascending,
      }),
      placed: rank().over({ orderBy: [entries.amount.descending] }),
      previous: lag(entries.amount, 2, 0n).over({
        partitionBy: [entries.team],
        orderBy: entries.id.ascending,
        rows: [{ preceding: 3 }, "current row"],
      }),
      next: lead(entries.amount).over({ orderBy: entries.id.ascending }),
      following: lead(entries.amount, 1).over({
        orderBy: entries.id.ascending,
      }),
      running: over(sum(entries.amount), {
        partitionBy: [entries.team],
        orderBy: entries.id.ascending,
        rows: ["unbounded preceding", "current row"],
      }),
      change: entries.amount.minus(
        lag(entries.amount).over({ orderBy: entries.id.ascending }),
      ),
    })),
  );
  compiled("window/prepared", () =>
    prepare({ team: text, size: int }, (parameters) =>
      model.entries(
        (entries) => ({
          previous: lag(entries.amount, 2, 0n).over({
            partitionBy: [entries.team],
            orderBy: entries.id.ascending,
          }),
        }),
        {
          where: (entries) => entries.team.is(parameters.team),
          limit: parameters.size,
        },
      ),
    ).toSQL({ team: "A", size: 3 }),
  );

  // -- pagination ------------------------------------------------------------
  const feed = model.posts((posts) => ({ id: posts.id, title: posts.title }), {
    where: (posts) => posts.views.above(1n),
    orderBy: (posts) => [posts.title.descending, posts.id.ascending],
  });
  let cursors: Awaited<ReturnType<typeof feed.page>> | undefined;

  await sent(
    "page/forward",
    async () => {
      cursors = await feed.page({ size: 2 });
    },
    3,
  );
  await sent(
    "page/after",
    async () => {
      cursors = await feed.page({ size: 2, after: cursors?.nextCursor });
    },
    3,
  );
  await sent(
    "page/before",
    () => feed.page({ size: 2, before: cursors?.previousCursor }),
    3,
  );
  /** A first page, the page after it, and the page before that one. */
  const pagedBothWays = async <Row>(
    name: string,
    ordered: {
      page: (options: PageOptions<Row>) => Promise<Page<Row>>;
    },
  ) => {
    let next: PageCursor<Row> | null = null;

    await sent(
      `page/${name}-forward`,
      async () => {
        next = (await ordered.page({ size: 1 })).nextCursor;
      },
      2,
    );
    await sent(
      `page/${name}-after`,
      async () => {
        next = (await ordered.page({ size: 1, after: next })).previousCursor;
      },
      2,
    );
    await sent(
      `page/${name}-before`,
      () => ordered.page({ size: 1, before: next }),
      2,
    );
  };

  await pagedBothWays(
    "composite-out-of-order",
    model.records(
      (records) => ({
        tenantId: records.tenantId,
        externalId: records.externalId,
        title: records.title,
        amount: records.amount,
      }),
      {
        orderBy: (records) => [
          records.tenantId.ascending,
          records.externalId.descending,
        ],
      },
    ),
  );
  await pagedBothWays(
    "composite-references",
    model.memberships(
      (memberships) => ({
        userId: memberships.userId,
        groupId: memberships.groupId,
        role: memberships.role,
      }),
      {
        orderBy: (memberships) => [
          memberships.userId.ascending,
          memberships.groupId.descending,
        ],
      },
    ),
  );
  await pagedBothWays(
    "scoped-composite",
    scoped.records(
      (records) => ({
        tenantId: records.tenantId,
        externalId: records.externalId,
        title: records.title,
        amount: records.amount,
      }),
      {
        orderBy: (records) => [
          records.tenantId.ascending,
          records.externalId.descending,
        ],
      },
    ),
  );
  await sent(
    "page/expression-and-window",
    async () => {
      const windowed = model.entries(
        (entries) => ({
          id: entries.id,
          position: rowNumber().over({ orderBy: entries.id.ascending }),
        }),
        {
          orderBy: (entries) => [
            entries.amount.plus(1).descending,
            entries.id.ascending,
          ],
        },
      );
      const first = await windowed.page({ size: 1 });

      await windowed.page({ size: 1, after: first.nextCursor });
    },
    2,
  );
  await sent(
    "page/unique-column",
    async () => {
      const users = model.users((users) => ({ id: users.id }), {
        orderBy: (users) => users.email.ascending,
      });
      const first = await users.page({ size: 1 });

      await users.page({ size: 1, after: first.nextCursor });
    },
    2,
  );
  await sent("page/incomplete-key", () =>
    model
      .records((records) => ({ title: records.title }), {
        orderBy: (records) => records.externalId.ascending,
      })
      .page({ size: 1 }),
  );
  await sent("page/joined-ordering", () =>
    model
      .posts((posts) => ({ id: posts.id }), {
        orderBy: (posts) => [posts.author.name.ascending, posts.id.ascending],
      })
      .page({ size: 1 }),
  );

  // -- terminals -------------------------------------------------------------
  await sent("terminal/count", () => model.posts.count());
  await sent("terminal/count-filtered", () =>
    model.posts({ where: (posts) => posts.author.name.is("Ada") }).count(),
  );
  await sent("terminal/count-limited", () => model.posts({ limit: 5 }).count());
  await sent("terminal/count-distinct", () =>
    model
      .posts((posts) => ({ title: posts.title }), { distinct: true })
      .count(),
  );
  await sent("terminal/count-scoped", () => scoped.users.count());
  await sent("terminal/exists", () => model.users.exists());
  await sent("terminal/exists-by-id", () =>
    model.records.byId({ tenantId: "a", externalId: "b" }).exists(),
  );
  await sent("terminal/exists-scoped", () =>
    scoped.posts({ where: (posts) => posts.views.above(1n) }).exists(),
  );
  await sent("terminal/first", () =>
    model.users((users) => ({ id: users.id })).first(),
  );
  await sent("terminal/maybe-one", () =>
    model.users
      .byId(1)((users) => ({ id: users.id }))
      .maybeOne(),
  );
  await sent("terminal/transaction", () =>
    model.$transaction(async (transaction) => {
      await transaction.users.insert({ email: "a", name: "A" });
      await transaction.users.byId(1).update({ name: "B" });
      await transaction.$transaction(async (nested) => {
        await nested.users.byId(1).delete();
      });
    }),
  );

  // -- prepared --------------------------------------------------------------
  compiled("prepared/select", () =>
    prepare({ name: text, size: int, after: int }, (parameters) =>
      model.users(
        (users) => ({
          id: users.id,
          total: users.posts.count(),
          posts: users.posts((posts) => ({ title: posts.title }), {
            where: (posts) => posts.author.name.is(parameters.name),
            limit: parameters.size,
          }),
        }),
        {
          where: (users) => users.id.above(parameters.after),
          orderBy: (users) => users.id.ascending,
          limit: parameters.size,
        },
      ),
    ).toSQL({ name: "Ada", size: 2, after: 5 }),
  );
  compiled("prepared/by-unique", () =>
    prepare({ email: text }, (parameters) =>
      model.users.by.email(parameters.email),
    ).toSQL({ email: "ada" }),
  );
  compiled("prepared/by-id-composite", () =>
    prepare({ tenant: text, id: text }, (parameters) =>
      model.records.byId({
        tenantId: parameters.tenant,
        externalId: parameters.id,
      }),
    ).toSQL({ tenant: "acme", id: "r1" }),
  );
  compiled("prepared/update", () =>
    prepare({ id: int, note: text }, (parameters) =>
      model.users
        .update(({ settings }) => ({
          settings: settings.set("note", parameters.note),
        }))
        .where((users) => users.id.is(parameters.id)),
    ).toSQL({ id: 7, note: 'say "hi"' }),
  );
  compiled("prepared/nullable", () =>
    prepare({ editor: int.nullable }, (parameters) =>
      model.posts((posts) => ({ id: posts.id }), {
        where: (posts) => posts.editorId.is(parameters.editor),
      }),
    ).toSQL({ editor: null }),
  );
  await sent("prepared/execute", () =>
    prepare({ id: int }, (parameters) =>
      model.users.byId(parameters.id)((users) => ({ id: users.id })),
    ).execute({ id: 3 }),
  );

  // -- JSON, search, dates ---------------------------------------------------
  compiled("json/paths", () =>
    model.users(
      (users) => ({
        theme: users.settings.path("theme"),
        email: users.settings.path("notifications", "email"),
        firstTag: users.settings.path("tags", 0),
        next: users.settings.path("tags").length(),
      }),
      {
        where: (users) => [
          users.settings.path("theme").is("dark"),
          users.settings.path("note").isNot(null),
          users.settings.path("theme").in(["dark", "light"]),
          users.settings.contains({ theme: "dark" }),
          users.settings.path("tags").has("sql"),
        ],
        orderBy: (users) => users.settings.path("theme").ascending,
      },
    ),
  );
  compiled("json/arithmetic-and-aggregates", () =>
    model.posts(
      (posts) => ({
        next: posts.metadata.path("rating").plus(1),
        total: sum(posts.metadata.path("rating")),
        best: maximum(posts.metadata.path("rating")),
      }),
      { where: (posts) => posts.metadata.path("rating").above(2) },
    ),
  );
  compiled("json/set", () =>
    model.users
      .update(({ settings, name }) => ({
        settings: settings
          .set(["notifications", "email"], true)
          .set(["tags", 0], "first")
          .set("note", null)
          .set("note", name),
      }))
      .where((users) => users.id.is(1))
      .returning((users) => ({ settings: users.settings })),
  );
  compiled("json/set-projection", () =>
    model.users((users) => ({
      preview: users.settings.set("theme", "light"),
    })),
  );
  compiled("search/match-and-rank", () =>
    model.posts(
      (posts) => ({
        id: posts.id,
        rank: posts.title.searchRank("bun sql", { language: "english" }),
        headline: posts.body.searchHeadline("bun sql"),
        stored: posts.document.searchRank("bun"),
      }),
      {
        where: (posts) => [
          posts.title.search("bun sql"),
          posts.document.search("bun", { language: "english" }),
        ],
        orderBy: (posts) => posts.title.searchRank("bun sql").descending,
      },
    ),
  );
  compiled("dates/trunc", () =>
    model.users(
      (users) => ({
        month: dateTrunc("month", users.createdAt),
        week: dateTrunc("week", users.createdAt, { timeZone: "Europe/Berlin" }),
        users: count(),
      }),
      {
        where: (users) =>
          dateTrunc("week", users.createdAt, {
            timeZone: "Europe/Berlin",
          }).atLeast(new Date("2024-01-01T00:00:00Z")),
        groupBy: (users) => [
          dateTrunc("month", users.createdAt),
          dateTrunc("week", users.createdAt, { timeZone: "Europe/Berlin" }),
        ],
        orderBy: (users) => dateTrunc("month", users.createdAt).descending,
      },
    ),
  );
  compiled("match/case", () =>
    model.posts(
      (posts) => ({
        label: posts.status.match({ draft: "d", published: "p" }),
      }),
      {
        where: (posts) => [
          posts.status.is.published,
          when(undefined, () => posts.id.is(1)),
          when(2, (id: number) => posts.id.is(id)),
        ],
      },
    ),
  );
  compiled("array/index-length-membership", () =>
    model.posts(
      (posts) => ({
        first: posts.labels.path(0),
        size: posts.labels.length(),
      }),
      {
        where: (posts) => [
          posts.labels.has("a"),
          posts.labels.contains(["a"]),
          posts.labels.overlaps(["x", "y"]),
          posts.labels.path(1).is("b"),
        ],
        orderBy: (posts) => posts.labels.path(0).ascending,
      },
    ),
  );
  compiled("search/document", () =>
    model.posts(
      (posts) => ({
        id: posts.id,
        rank: searchDocument(
          { A: posts.title, B: [posts.body] },
          { language: "english" },
        ).searchRank("bun"),
      }),
      {
        where: (posts) =>
          searchDocument(
            { A: posts.title, B: [posts.body] },
            { language: "english" },
          ).search("bun"),
      },
    ),
  );

  // -- subqueries ------------------------------------------------------------
  compiled("subquery/exists-in-scalar", () =>
    model.users((users) => ({ name: users.name }), {
      where: (users) => [
        exists(
          model.posts((posts) => ({ id: posts.id }), {
            where: (posts) => [
              posts.authorId.is(users.id),
              posts.title.ilike("%sql%"),
            ],
          }),
        ),
        users.id.in(model.posts((posts) => ({ authorId: posts.authorId }))),
        users.visits.above(
          model.users
            .as("others")((others) => ({
              maximum: maximum(others.visits),
            }))
            .scalar(),
        ),
      ],
    }),
  );
  compiled("subquery/derived", () => {
    const recent = model
      .posts((posts) => ({ authorId: posts.authorId }), {
        where: (posts) => posts.views.above(9n),
      })
      .as("recent");

    return recent((recent) => ({ authorId: recent.authorId }));
  });

  // -- schema ----------------------------------------------------------------
  add("schema/snapshot", {
    sql: JSON.stringify(plain(model.$snapshot())),
    parameters: [],
  });
  add("schema/create-indexes", {
    statements: model
      .$createIndexes()
      .toSQL()
      .map((query: CompiledQuery) => statement(query)),
  });

  // -- invalid queries -------------------------------------------------------
  await failure("invalid/by-id-missing-field", () =>
    model.records.byId({ tenantId: "acme" } as never),
  );
  await failure("invalid/by-id-null", () => model.users.byId(null as never));
  await failure("invalid/by-unique-fields", () =>
    model.handles.by.identity({ tenant: "one" } as never),
  );
  await failure("invalid/update-without-where", () =>
    model.users.update({ name: "x" }),
  );
  await failure("invalid/delete-without-where", () => model.users.delete());
  await failure("invalid/unknown-column", () =>
    model.users.update({ missing: 1 } as never),
  );
  await failure("invalid/foreign-scope", () => {
    let foreign: SelectedColumn | undefined;

    model.posts((posts) => {
      foreign = posts.author.name;

      return { id: posts.id };
    });

    return model.posts(() => ({ foreign: foreign! }));
  });
  await failure("invalid/foreign-scope-window", () => {
    let foreign: unknown;

    model.entries.as("other")((other) => {
      foreign = other.id;

      return { id: other.id };
    });

    return model.entries(() => ({
      value: rowNumber().over({ partitionBy: [foreign as never] }),
    }));
  });
  await failure("invalid/page-order", () =>
    model
      .posts((posts) => ({ id: posts.id }), {
        orderBy: (posts) => posts.title.ascending,
      })
      .page({ size: 1 }),
  );
  await failure("invalid/page-cursor", () =>
    feed.page({ size: 1, after: "broken" as never }),
  );
  await failure("invalid/cte-table-name", () =>
    model.users((users) => ({ id: users.id })).cte("users"),
  );
  await failure("invalid/cte-duplicate", () => {
    const first = model.entries((entries) => ({ id: entries.id })).cte("first");
    const conflict = model
      .entries((entries) => ({ id: entries.id }), {
        where: (entries) => entries.id.is(3),
      })
      .cte("first")
      .as("other");

    return first((first, { innerJoin }) => {
      innerJoin(conflict, (other) => first.id.is(other.id));

      return { id: first.id };
    });
  });
  await failure("invalid/cte-escaped", () => {
    let escaped: unknown;

    model
      .entries((entries) => ({ id: entries.id }))
      .recursive("tree", (tree) => {
        escaped = tree((tree) => ({ id: tree.id }));

        return tree((tree) => ({ id: tree.id }));
      });

    return escaped;
  });
  await failure("invalid/conflict-columns", () =>
    model.users.insert({ email: "a", name: "A" }).onConflict().doUpdate({
      name: "B",
    }),
  );
  await failure("invalid/missing-required", () =>
    model.users.insert({ name: "A" } as never),
  );
  await failure("invalid/date-trunc", () =>
    model.users((users) => ({
      value: dateTrunc("month", users.name as never),
    })),
  );
  await failure("invalid/scope-unknown-table", () =>
    model.$scope({ missing: () => undefined } as never),
  );
  await failure("invalid/scope-not-a-callback", () =>
    model.$scope({ users: 1 } as never),
  );
  await failure("invalid/relation-path-without-key", () => {
    const keyless = schema({
      owners: { id: int.auto, name: text },
      items: ({ owners }) => table({ owner: owners, label: text }),
    });

    return keyless.items
      .update({ label: "x" })
      .where((items) => items.owner.name.is("Ada"));
  });
  await failure("invalid/condition-one-without-key", () => {
    const plain = table({ name: text, active: bool });
    const keyless = schema({
      people: plain,
      notes: table({ id: int.auto, owner: text }).relations((note, { to }) => ({
        person: to(plain).one((person) => note.owner.is(person.name)),
      })),
    });

    return keyless.notes((note) => ({ person: note.person.name }));
  });
  await failure("invalid/by-id-without-key", () =>
    (
      schema({ plain: table({ name: text }) }).plain as unknown as {
        byId: (value: number) => unknown;
      }
    ).byId(1),
  );
  await failure("invalid/transaction-retries", () =>
    model.$transaction(async () => {}, { retries: 21 }),
  );
  await failure("invalid/transaction-retry-delay", () =>
    model.$transaction(async () => {}, { retries: 1, retryDelayMs: -1 }),
  );
  await failure("invalid/transaction-savepoint-options", () =>
    model.$transaction((transaction) =>
      (transaction.$transaction as unknown as typeof model.$transaction)(
        async () => {},
        { retries: 1 },
      ),
    ),
  );

  // -- invalid schemas: which error wins ------------------------------------
  const invalidSchema = (name: string, build: () => unknown) =>
    failure(`invalid-schema/${name}`, () => {
      build();

      return undefined;
    });

  await invalidSchema("nullable-key", () =>
    schema({
      records: table({ id: int, value: text.nullable }).primaryKey(
        (records) => [records.value],
      ),
    }),
  );
  await invalidSchema("conflicting-keys", () =>
    schema({
      records: table({ code: text.primaryKey, other: int }).primaryKey(
        (records) => [records.other],
      ),
    }),
  );
  await invalidSchema("composite-target", () =>
    schema({
      parents: table({ first: int, second: int }).primaryKey((parents) => [
        parents.first,
        parents.second,
      ]),
      children: ({ parents }) => ({ id: int, parent: parents }),
    }),
  );
  await invalidSchema("reserved-name", () => schema({ $scope: { id: int } }));
  await invalidSchema("reserved-name-before-nullable-key", () =>
    schema({
      then: { id: int.nullable },
    }),
  );
  await invalidSchema("nullable-key-before-unknown-target", () =>
    schema({
      first: { id: int.nullable },
      second: ({ first }) => ({ id: int, first: first.by("missing" as never) }),
    }),
  );
  await invalidSchema("builder-before-reserved-name", () =>
    schema({
      then: { id: int },
      other: { id: int, name: numeric },
    }),
  );
  await invalidSchema("outside-table", () =>
    schema({ posts: { id: int, author: table({ id: int }) } } as never),
  );
  await invalidSchema("ambiguous-reference", () => {
    const shared = table({ id: int });

    return schema({
      first: shared,
      second: shared,
      third: { id: int, owner: shared },
    } as never);
  });
  await invalidSchema("by-not-unique", () =>
    schema({
      users: { id: int, name: text },
      posts: ({ users }) => ({ id: int, author: users.by("name" as never) }),
    }),
  );
  await invalidSchema("junction-inverse", () =>
    schema({
      users: { id: int },
      groups: { id: int },
      links: ({ users, groups }) =>
        junction({ user: users.inverse("x"), group: groups }),
    }),
  );
  await invalidSchema("junction-inverse-before-composite-target", () =>
    schema({
      users: { id: int },
      pairs: table({ a: int, b: int }).primaryKey((pairs) => [
        pairs.a,
        pairs.b,
      ]),
      links: ({ users, pairs }) =>
        junction({ user: users.inverse("x"), pair: pairs }),
    }),
  );
  await invalidSchema("duplicate-inverse", () =>
    schema({
      users: { id: int },
      posts: ({ users }) => ({
        id: int,
        author: users.inverse("written"),
        editor: users.inverse("written" as never),
      }),
    }),
  );
  await invalidSchema("duplicate-inverse-before-relation-clash", () =>
    schema({
      users: { id: int, name: text },
      posts: ({ users }) =>
        table({
          id: int,
          title: text,
          author: users.inverse("written"),
          editor: users.inverse("written" as never),
        }).relations((post, { to }) => ({
          title: to(users).one((user) => post.title.is(user.name)),
        })),
    }),
  );
  await invalidSchema("relation-clash", () =>
    schema({
      users: { id: int, name: text },
      posts: ({ users }) =>
        table({ id: int, title: text, author: users }).relations(
          (post, { to }) => ({
            authorId: to(users).one((user) => post.title.is(user.name)),
          }),
        ),
    }),
  );
  await invalidSchema("relation-clash-before-casing", () =>
    schema(
      {
        users: { id: int, name: text },
        posts: ({ users }) =>
          table({ id: int, title: text }).relations((post, { to }) => ({
            title: to(users).one((user) => post.title.is(user.name)),
          })),
      },
      { casing: "kebab" } as never,
    ),
  );
  await invalidSchema("relation-outside", () =>
    schema({
      posts: table({ id: int, title: text }).relations((post, { to }) => ({
        other: to(table({ id: int, name: text })).one((user) =>
          post.title.is(user.name),
        ),
      })),
    }),
  );
  await invalidSchema("casing-before-extension", () =>
    schema({ users: { id: int } }, {
      casing: "kebab",
      extensions: ["Bad Name"],
    } as never),
  );
  await invalidSchema("extension-before-executor", () =>
    schema(
      { users: { id: int } },
      {
        extensions: ["Bad Name"],
        executor: async () => [],
        driver: { execute: async () => [], close: async () => {} },
      },
    ),
  );
  await invalidSchema("executor-and-driver-before-index", () =>
    schema(
      {
        users: table({ id: int, name: text.index }).indexes((users) => ({
          name: index(users.name),
        })),
      },
      {
        executor: async () => [],
        driver: { execute: async () => [], close: async () => {} },
      } as never,
    ),
  );
  await invalidSchema("duplicate-index", () =>
    schema({
      users: table({ id: int, name: text.index }).indexes((users) => ({
        name: index(users.name),
      })),
    }),
  );
  await invalidSchema("duplicate-index-before-duplicate-check", () =>
    schema({
      users: table({ id: int, name: text.index })
        .indexes((users) => ({ name: index(users.name) }))
        .checks((users) => ({ same: users.id.above(0) }))
        .checks((users) => ({ same: users.id.below(10) })),
    }),
  );
  await invalidSchema("duplicate-check", () =>
    schema({
      users: table({ id: int })
        .checks((users) => ({ same: users.id.above(0) }))
        .checks((users) => ({ same: users.id.below(10) })),
    }),
  );
  await invalidSchema("duplicate-unique-lookup", () =>
    schema({
      users: table({ id: int, email: text.unique, name: text }).indexes(
        (users) => ({ email: index(users.name).unique }),
      ),
    }),
  );
  await invalidSchema("check-with-aggregate", () =>
    schema({
      users: table({ id: int }).checks((users) => ({
        total: count().above(users.id),
      })),
    }),
  );
  await invalidSchema("check-with-array-length", () =>
    schema({
      users: table({ id: int, tags: text.array }).checks((users) => ({
        tagged: users.tags.length().above(0),
      })),
    }),
  );
  await invalidSchema("index-with-subquery", () =>
    schema({
      users: table({ id: int }).indexes((users) => ({
        partial: index(users.id).where(
          exists(model.posts((posts) => ({ id: posts.id }))),
        ),
      })),
    }),
  );
  await invalidSchema("index-with-search", () =>
    schema({
      users: table({ id: int, name: text }).indexes((users) => ({
        partial: index(users.id).where(users.name.search("x")),
      })),
    }),
  );
  await invalidSchema("table-in-two-schemas", () => {
    const users = table({ id: int });
    const first = schema({ users });

    return [first, schema({ people: users })];
  });
  await invalidSchema("same-sql-name", () =>
    schema({
      userPosts: { id: int },
      user_posts: { id: int },
    }),
  );
  await invalidSchema("thunk-returns-column", () =>
    schema({ posts: { id: int, author: () => int } } as never),
  );
  await invalidSchema("keys-mismatch", () =>
    schema.keys({ users: text })({ users: { id: int } }),
  );
  await invalidSchema("keys-unknown-table", () =>
    schema.keys({ missing: int })({ users: { id: int } } as never),
  );

  return golden;
};
