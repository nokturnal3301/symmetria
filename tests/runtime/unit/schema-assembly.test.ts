import { describe, expect, test } from "bun:test";
import {
  schema,
  table,
  junction,
  uuid,
  text,
  int,
  bool,
  oneOf,
  timestamptz,
} from "../../../packages/runtime/src";

const database = schema({
  users: {
    id: uuid.v7,
    email: text.unique,
    name: text.nullable,
    role: oneOf("admin", "member", "guest"),
    createdAt: timestamptz.now,
  },
  profiles: ({ users }) => ({
    id: uuid.v7,
    bio: text.nullable,
    user: users.unique,
  }),
  posts: ({ users }) => ({
    id: uuid.v7,
    title: text,
    views: int.default(0),
    published: bool.default(false),
    author: users.inverse("authored"),
    editor: users.nullable.onDelete.setNull.inverse("edited"),
    createdAt: timestamptz.now,
  }),
  tags: { id: uuid.v7, name: text.unique },
  postTags: ({ posts, tags }) =>
    junction({ post: posts, tag: tags, addedAt: timestamptz.now }),
  categories: ({ categories }) => ({
    id: uuid.v7,
    title: text,
    parent: categories.nullable.inverse("children"),
  }),
});

const snapshot = database.$snapshot();
const tablesByName = Object.fromEntries(
  snapshot.tables.map((table) => [table.name, table]),
);

const column = (tableName: string, columnName: string) => {
  const foundColumn = tablesByName[tableName]?.columns.find(
    (column) => column.name === columnName,
  );

  if (!foundColumn) {
    throw new Error(`no column ${tableName}.${columnName}`);
  }

  return foundColumn;
};

const relation = (tableName: string, relationName: string) => {
  const foundRelation = tablesByName[tableName]?.relations.find(
    (relation) => relation.name === relationName,
  );

  if (!foundRelation) {
    throw new Error(`no relation ${tableName}.${relationName}`);
  }

  return foundRelation;
};

describe("naming", () => {
  test("tables are named by their schema() keys, snake_cased", () => {
    expect(tablesByName.postTags?.sqlName).toBe("post_tags");
    expect(tablesByName.users?.sqlName).toBe("users");
    expect(database.postTags.$name).toBe("post_tags");
  });

  test("columns are snake_cased", () => {
    expect(column("users", "createdAt").sqlName).toBe("created_at");
  });
});

describe("columns", () => {
  test("id convention makes it the primary key", () => {
    expect(column("users", "id").primaryKey).toBe(true);
    expect(column("users", "email").primaryKey).toBe(false);
  });

  test("semantic defaults: uuid.v7 / timestamptz.now", () => {
    expect(column("users", "id").default).toEqual({
      kind: "sql",
      sql: "uuidv7()",
    });
    expect(column("users", "createdAt").default).toEqual({
      kind: "sql",
      sql: "now()",
    });
  });

  test("value defaults", () => {
    expect(column("posts", "views").default).toEqual({
      kind: "value",
      value: 0,
    });
    expect(column("posts", "published").default).toEqual({
      kind: "value",
      value: false,
    });
  });

  test("modifiers: unique / nullable", () => {
    expect(column("users", "email").unique).toBe(true);
    expect(column("users", "name").notNull).toBe(false);
    expect(column("users", "email").notNull).toBe(true);
  });

  test("oneOf collects enum values", () => {
    expect(column("users", "role").enumerationValues).toEqual([
      "admin",
      "member",
      "guest",
    ]);
  });
});

describe("foreign keys from table-valued columns", () => {
  test("author: users → author_id uuid NOT NULL references users(id)", () => {
    const foreignKey = column("posts", "authorId");
    expect(foreignKey.sqlName).toBe("author_id");
    expect(foreignKey.sqlType).toBe("uuid");
    expect(foreignKey.notNull).toBe(true);
    expect(foreignKey.references).toEqual({
      table: "users",
      column: "id",
      onDelete: "restrict",
    });
  });

  test("editor: users.nullable.onDelete.setNull → nullable FK with set null", () => {
    const foreignKey = column("posts", "editorId");
    expect(foreignKey.notNull).toBe(false);
    expect(foreignKey.references?.onDelete).toBe("set null");
  });

  test("user: users.unique → 1:1 unique FK", () => {
    const foreignKey = column("profiles", "userId");
    expect(foreignKey.unique).toBe(true);
    expect(foreignKey.notNull).toBe(true);
  });

  test("self reference targets own table and allows null", () => {
    const foreignKey = column("categories", "parentId");
    expect(foreignKey.references?.table).toBe("categories");
    expect(foreignKey.notNull).toBe(false);
  });
});

describe("junction()", () => {
  test("both foreign keys form the composite primary key", () => {
    expect(tablesByName.postTags?.junction).toBe(true);
    expect(column("postTags", "postId").primaryKey).toBe(true);
    expect(column("postTags", "tagId").primaryKey).toBe(true);
  });

  test("extra data columns stay ordinary columns", () => {
    expect(column("postTags", "addedAt").primaryKey).toBe(false);
  });

  test("a plain two-reference table is not a junction", () => {
    const plain = schema({
      users: { id: uuid.v7 },
      teams: { id: uuid.v7 },
      memberships: ({ users, teams }) => ({ user: users, team: teams }),
    });
    const memberships = plain
      .$snapshot()
      .tables.find((table) => table.name === "memberships");
    expect(memberships?.junction).toBe(false);
    expect(memberships?.columns.every((column) => !column.primaryKey)).toBe(
      true,
    );
    expect(
      plain
        .$snapshot()
        .tables.find((table) => table.name === "users")
        ?.relations.map((relation) => relation.name),
    ).toEqual(["memberships"]);
    expect(tablesByName.profiles?.junction).toBe(false);
  });

  test("declaration errors are reported at junction()", () => {
    const users = table({ id: uuid.v7 });
    const teams = table({ id: uuid.v7 });
    expect(() => junction({ user: users })).toThrow(/exactly two/);
    expect(() => junction({ user: users, team: teams, id: uuid.v7 })).toThrow(
      /both foreign keys/,
    );
    expect(() =>
      junction({ user: users, team: teams, code: text.primaryKey }),
    ).toThrow(/both foreign keys/);
    expect(() =>
      (
        junction({ user: users, team: teams }) as unknown as {
          primaryKey: (callback: () => never[]) => unknown;
        }
      ).primaryKey(() => []),
    ).toThrow(/both foreign keys/);
  });
});

describe("relations", () => {
  test("forward: posts.author / posts.editor", () => {
    expect(relation("posts", "author")).toMatchObject({
      kind: "one",
      target: "users",
      nullable: false,
    });
    expect(relation("posts", "editor")).toMatchObject({
      kind: "one",
      target: "users",
      nullable: true,
    });
  });

  test("reverse 1:1 is a single object relation", () => {
    expect(relation("users", "profiles")).toMatchObject({
      kind: "one",
      target: "profiles",
      reverse: true,
    });
  });

  test("ambiguous reverses use inverse() names", () => {
    expect(relation("users", "authored")).toMatchObject({
      kind: "many",
      target: "posts",
      foreignKey: "authorId",
    });
    expect(relation("users", "edited")).toMatchObject({
      kind: "many",
      target: "posts",
      foreignKey: "editorId",
    });
  });

  test("M:N through junction, both directions", () => {
    expect(relation("posts", "tags")).toMatchObject({
      kind: "through",
      target: "tags",
      junction: "postTags",
      sourceForeignKey: "postId",
      targetForeignKey: "tagId",
    });
    expect(relation("tags", "posts")).toMatchObject({
      kind: "through",
      target: "posts",
      junction: "postTags",
    });
  });

  test("junction itself stays reachable as a reverse relation", () => {
    expect(relation("posts", "postTags")).toMatchObject({
      kind: "many",
      reverse: true,
    });
  });

  test("self-reference: forward auto, reverse via inverse()", () => {
    expect(relation("categories", "parent")).toMatchObject({
      kind: "one",
      target: "categories",
      nullable: true,
    });
    expect(relation("categories", "children")).toMatchObject({
      kind: "many",
      target: "categories",
      reverse: true,
    });
  });
});

describe("errors", () => {
  test("ambiguous reverse without inverse() throws with guidance", () => {
    expect(() =>
      // @ts-expect-error colliding inverse names fail during type checking too
      schema({
        users: { id: uuid.v7 },
        posts: ({ users }) => ({ id: uuid.v7, author: users, editor: users }),
      }),
    ).toThrow(/ambiguous/);
  });

  test("referencing a table outside the schema throws", () => {
    const outside = table({ id: uuid.v7 });
    const inside = table({ id: uuid.v7, reference: outside });
    // @ts-expect-error the referenced table must be part of the registry
    expect(() => schema({ inside })).toThrow(/outside this schema/);
  });

  test("referencing a table without a primary key throws", () => {
    const withoutPrimaryKey = table({ label: text });
    const other = table({ id: uuid.v7, reference: withoutPrimaryKey });
    expect(() => schema({ withoutPrimaryKey, other })).toThrow(/primary key/);
  });
});

describe("snapshot is plain data", () => {
  test("round-trips through JSON", () => {
    const json = JSON.parse(JSON.stringify(snapshot));
    expect(json).toEqual(snapshot);
  });

  test("tables are sorted for stable diffs", () => {
    const names = snapshot.tables.map((table) => table.name);
    expect(names).toEqual([...names].sort());
  });
});
