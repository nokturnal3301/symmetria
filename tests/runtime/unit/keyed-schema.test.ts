import { expect, test } from "bun:test";
import { schema, type Link, uuid, int } from "../../../packages/runtime/src";
import { model } from "../../fixtures/keyed-schema";

type AreEqual<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : false
  : false;
type Expect<Condition extends true> = Condition;

const snapshot = (name: string) => {
  return model.$snapshot().tables.find((table) => table.name === name)!;
};

test("identical table shapes have distinct forward and inverse relations", () => {
  expect(
    snapshot("posts").relations.filter((relation) => relation.kind === "one"),
  ).toEqual([
    {
      name: "author",
      kind: "one",
      target: "users",
      foreignKey: "authorId",
      nullable: false,
    },
    {
      name: "editor",
      kind: "one",
      target: "users",
      foreignKey: "editorId",
      nullable: true,
    },
    {
      name: "team",
      kind: "one",
      target: "teams",
      foreignKey: "teamId",
      nullable: false,
    },
  ]);
  expect(snapshot("users").relations.map((relation) => relation.name)).toEqual([
    "profile",
    "authored",
    "edited",
  ]);
  expect(snapshot("teams").relations.map((relation) => relation.name)).toEqual([
    "posts",
  ]);
});

test("inverse names preserve one-to-one cardinality and FK constraints", () => {
  expect(
    snapshot("users").relations.find((relation) => relation.name === "profile"),
  ).toMatchObject({
    kind: "one",
    target: "profiles",
    reverse: true,
  });
  expect(
    snapshot("profiles").columns.find((column) => column.name === "userId"),
  ).toMatchObject({
    sqlType: "uuid",
    notNull: true,
    unique: true,
  });
  expect(
    snapshot("posts").columns.find((column) => column.name === "editorId"),
  ).toMatchObject({
    notNull: false,
    references: { table: "users", onDelete: "set null" },
  });
});

test("junctions retain payload and expose both traversal directions", () => {
  expect(
    snapshot("postTags")
      .columns.filter((column) => column.primaryKey)
      .map((column) => column.name),
  ).toEqual(["postId", "tagId"]);
  expect(
    snapshot("postTags").columns.find((column) => column.name === "addedAt")
      ?.primaryKey,
  ).toBe(false);
  expect(
    snapshot("posts").relations.find((relation) => relation.name === "tags"),
  ).toMatchObject({
    kind: "through",
    target: "tags",
    junction: "postTags",
  });
  expect(
    snapshot("tags").relations.find((relation) => relation.name === "posts"),
  ).toMatchObject({
    kind: "through",
    target: "posts",
    junction: "postTags",
  });
});

test("mutual references resolve after all table bodies, inheriting the correct PK types", () => {
  const cyclic = schema({
    users: ({ teams }) => ({
      id: uuid.v7,
      team: teams.nullable.inverse("members"),
    }),
    teams: ({ users }) => ({
      id: int.auto,
      owner: users.inverse("ownedTeams"),
    }),
  });
  type TeamIdentifierMatches = Expect<
    AreEqual<typeof cyclic.users.$row.teamId, number | null>
  >;
  type OwnerIdentifierMatches = Expect<
    AreEqual<typeof cyclic.teams.$row.ownerId, string>
  >;
  const [teams, users] = cyclic.$snapshot().tables;
  expect(
    users?.columns.find((column) => column.name === "teamId"),
  ).toMatchObject({
    sqlType: "integer",
    references: { table: "teams", column: "id" },
  });
  expect(
    teams?.columns.find((column) => column.name === "ownerId")?.sqlType,
  ).toBe("uuid");
});

test("self references need no thunk or special self marker", () => {
  expect(snapshot("categories").relations).toEqual([
    {
      name: "parent",
      kind: "one",
      target: "categories",
      foreignKey: "parentId",
      nullable: true,
    },
    {
      name: "children",
      kind: "many",
      target: "categories",
      foreignKey: "parentId",
      reverse: true,
    },
  ]);
  const unnamed = schema({
    nodes: ({ nodes }) => ({ id: uuid, parent: nodes.nullable }),
  });
  expect(
    unnamed.$snapshot().tables[0]?.relations.map((relation) => relation.name),
  ).toEqual(["parent"]);
});

test("a failed assembly leaves reusable definitions intact", () => {
  const users = { id: uuid };

  const posts = ({ users }: { users: Link<"users"> }) => ({
    id: uuid,
    first: users,
    second: users,
  });

  // @ts-expect-error two unnamed inverse relations both claim users.posts
  expect(() => schema({ users, posts })).toThrow(/ambiguous/);
  const fixed = {
    users,
    posts: ({ users }: { users: Link<"users"> }) => ({
      id: uuid,
      first: users.inverse("firstPosts"),
      second: users.inverse("secondPosts"),
    }),
  };
  const firstSchema = schema(fixed);
  const secondSchema = schema(fixed);
  expect(firstSchema.$snapshot()).toEqual(secondSchema.$snapshot());
  firstSchema.$snapshot().tables.length = 0;
  expect(firstSchema.$snapshot().tables).toHaveLength(2);
});

test("three references without id do not imply a junction", () => {
  const tripleReferences = schema({
    users: { id: uuid },
    teams: { id: uuid },
    workspaces: { id: uuid },
    records: ({ users, teams, workspaces }) => ({
      user: users,
      team: teams,
      workspace: workspaces,
    }),
  });
  expect(
    tripleReferences
      .$snapshot()
      .tables.find((table) => table.name === "records")?.junction,
  ).toBe(false);
  expect(
    tripleReferences
      .$snapshot()
      .tables.find((table) => table.name === "users")
      ?.relations.map((relation) => relation.name),
  ).toEqual(["records"]);
});
