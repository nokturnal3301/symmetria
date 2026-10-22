import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
  junction,
  schema,
  table,
  int,
  text,
  oneOf,
  index,
} from "../../../packages/runtime/src";
import {
  highlightSQL,
  inspectEntries,
  inspectTableSQL,
  matchingTables,
} from "../../../packages/kit/src/cli/inspect-data";

const snapshot = schema({
  userProfiles: { id: int.auto, displayName: text.unique },
  posts: ({ userProfiles }) =>
    table({
      id: int.auto,
      title: text,
      state: oneOf("draft", "published").default("draft"),
      author: userProfiles,
      editor: userProfiles.nullable.inverse("edited"),
    })
      .indexes((posts) => ({
        title: index(posts.title)
          .unique.include(posts.state)
          .where(posts.state.is("published")),
      }))
      .checks((posts) => ({ title: posts.title.isNot("") })),
  labels: { id: int.auto, label: text },
  postLabels: ({ posts, labels }) => junction({ post: posts, label: labels }),
}).$snapshot();
const posts = snapshot.tables.find((table) => table.name === "posts")!;
const users = snapshot.tables.find((table) => table.name === "userProfiles")!;

test("inspect links physical foreign keys and logical reverse/through relationships to their targets", () => {
  expect(
    inspectEntries(posts, "Columns").find((entry) => entry.name === "editorId"),
  ).toMatchObject({
    badges: ["FK", "NULL"],
    target: { table: "user_profiles", column: "id" },
  });
  expect(
    inspectEntries(posts, "Relations").find((entry) => entry.name === "author"),
  ).toMatchObject({ target: { table: "userProfiles", column: "id" } });
  expect(
    inspectEntries(users, "Relations").find((entry) => entry.name === "edited"),
  ).toMatchObject({
    badges: ["REVERSE"],
    target: { table: "posts", column: "editorId" },
  });
  expect(
    inspectEntries(posts, "Relations").find((entry) => entry.name === "labels"),
  ).toMatchObject({ kind: "many ↔ many", target: { table: "labels" } });
  expect(
    inspectEntries(
      snapshot.tables.find((table) => table.name === "postLabels")!,
      "Columns",
    ).every((entry) => entry.badges.includes("PK")),
  ).toBe(true);
  expect(
    matchingTables(snapshot, "DISPLAY_NAME").map((table) => table.name),
  ).toEqual(["userProfiles"]);
  expect(matchingTables(snapshot, "user_profiles")).toContain(users);
  expect(matchingTables(snapshot, "no_such_field")).toEqual([]);
});

test("SQL tab includes enum definitions, constraints, partial/covering indexes and physical names", () => {
  const sql = inspectTableSQL(snapshot, posts);
  expect(sql).toContain('CREATE TYPE "posts_state_enum" AS ENUM');
  expect(sql).toContain('CREATE TABLE "posts"');
  expect(sql).toContain('REFERENCES "user_profiles" ("id")');
  expect(sql).toContain("GENERATED ALWAYS AS IDENTITY");
  expect(sql).toContain('PRIMARY KEY ("id")');
  expect(sql).toContain('CHECK ("title" <>');
  expect(sql).toContain("CREATE UNIQUE INDEX");
  expect(sql).toContain('INCLUDE ("state") WHERE');
  expect(sql).not.toContain('CREATE TABLE "user_profiles"');
  const details = inspectEntries(posts, "Indexes")[0]!;
  expect(details.description).toContain("Include:");
  expect(details.description).toContain("Where:");
});

test("SQL highlighting preserves literal SQL including escaped quotes, dollar strings and comments", () => {
  const sql = `-- CREATE 42\nCREATE TABLE "a""b" ("value" text DEFAULT E'can\\'t SELECT', "body" text DEFAULT $body$'SQL' $other$ text$body$, "日本語" integer DEFAULT 1e-3); /* NULL */`;
  const highlighted = highlightSQL(sql, true);
  expect(stripVTControlCharacters(highlighted)).toBe(sql);
  expect(highlighted).toContain("\u001b[");
  expect(highlightSQL(sql, false)).toBe(sql);
});
