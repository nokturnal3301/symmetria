import { expect, test } from "bun:test";
import {
  schema,
  table,
  junction,
  int,
  bigint,
  text,
  numeric,
  oneOf,
  timestamptz,
} from "../../../packages/runtime/src";
import {
  migrationSnapshot,
  renderMermaid,
  schemaGraph,
} from "../../../packages/kit/src";

const users = table({ id: int.auto, email: text.unique });
const posts = table({
  id: bigint.auto,
  author: users,
  editor: users.nullable.inverse("edited"),
  state: oneOf("draft", "published").default("draft"),
  price: numeric(12, 2),
  publishedAt: timestamptz.nullable,
});
const tags = table({ id: int.auto, label: text.unique });
const postTags = junction({ post: posts, tag: tags });
const profiles = table({ user: users.unique, bio: text.nullable });
const model = schema({ users, posts, tags, postTags, profiles });

test("schemaGraph describes tables, keys and foreign-key edges", () => {
  const graph = schemaGraph(model.$snapshot());
  const named = (name: string) =>
    graph.tables.find((entry) => entry.name === name)!;

  // Snapshots list tables and columns in a stable, sorted order.
  expect(graph.tables.map((entry) => entry.name)).toEqual([
    "post_tags",
    "posts",
    "profiles",
    "tags",
    "users",
  ]);
  expect(named("post_tags").junction).toBe(true);
  expect(named("posts").junction).toBe(false);
  expect(
    named("posts").columns.find((column) => column.name === "state"),
  ).toEqual({
    name: "state",
    type: "posts_state_enum",
    primaryKey: false,
    foreignKey: false,
    unique: false,
    nullable: false,
    identity: false,
  });
  expect(graph.edges).toEqual([
    {
      from: "posts",
      to: "post_tags",
      column: "post_id",
      label: "post",
      optional: false,
      one: false,
      identifying: true,
    },
    {
      from: "tags",
      to: "post_tags",
      column: "tag_id",
      label: "tag",
      optional: false,
      one: false,
      identifying: true,
    },
    {
      from: "users",
      to: "posts",
      column: "author_id",
      label: "author",
      optional: false,
      one: false,
      identifying: false,
    },
    {
      from: "users",
      to: "posts",
      column: "editor_id",
      label: "editor",
      optional: true,
      one: false,
      identifying: false,
    },
    {
      from: "users",
      to: "profiles",
      column: "user_id",
      label: "user",
      optional: false,
      one: true,
      identifying: false,
    },
  ]);
  // Migration snapshots describe the same graph.
  expect(schemaGraph(migrationSnapshot(model.$snapshot()))).toEqual(graph);
});

test("renderMermaid produces an erDiagram with keys, comments and cardinalities", () => {
  const graph = schemaGraph(model.$snapshot());

  expect(renderMermaid(graph)).toBe(`erDiagram
  post_tags {
    bigint post_id PK, FK
    integer tag_id PK, FK
  }
  posts {
    bigint id PK "identity"
    integer author_id FK
    integer editor_id FK "nullable"
    posts_state_enum state
    numeric(12_2) price
    timestamptz published_at "nullable"
  }
  profiles {
    integer user_id FK, UK
    text bio "nullable"
  }
  tags {
    integer id PK "identity"
    text label UK
  }
  users {
    integer id PK "identity"
    text email UK
  }

  posts ||--o{ post_tags : post
  tags ||--o{ post_tags : tag
  users ||..o{ posts : author
  users |o..o{ posts : editor
  users ||..o| profiles : user
`);
  expect(renderMermaid(graph, { compact: true })).toContain(
    "  post_tags\n  posts\n  profiles\n",
  );
  expect(
    renderMermaid(graph, { fenced: true }).startsWith(
      "```mermaid\nerDiagram\n",
    ),
  ).toBe(true);
  expect(renderMermaid(graph, { fenced: true }).endsWith("```\n")).toBe(true);
});

test("edges of by() and column() references are labelled by their relation name", () => {
  const accounts = table({ id: int.auto, email: text.unique });
  const notes = table({
    id: int.auto,
    author: accounts.by("email").column("author_email"),
    owner: accounts.column("created_by").nullable.inverse("owned"),
  });
  const graph = schemaGraph(schema({ accounts, notes }).$snapshot());

  expect(graph.edges.map((edge) => [edge.column, edge.label])).toEqual([
    ["author_email", "author"],
    ["created_by", "owner"],
  ]);
  expect(renderMermaid(graph)).toContain("accounts ||..o{ notes : author");
  expect(renderMermaid(graph)).toContain("accounts |o..o{ notes : owner");
});

test("names Mermaid cannot take as attributes become words with the real name in the note; labels are quoted", () => {
  const people = table({
    id: int.auto,
    firstName: text.named("First Name"),
    firstUnderscore: text.named("First_Name").nullable,
    quoted: text.named('quote"col').nullable,
    twoFactor: text.named("2fa").nullable,
    manager: users.column("manager id").nullable,
  });
  const graph = schemaGraph(schema({ users, people }).$snapshot());
  const diagram = renderMermaid(graph);

  expect(diagram).toContain('    text First_Name "name: First Name"\n');
  // Two names that become the same word stay apart.
  expect(diagram).toContain(
    '    text First_Name_2 "name: First_Name, nullable"\n',
  );
  expect(diagram).toContain(`    text quote_col "name: quote'col, nullable"\n`);
  expect(diagram).toContain('    text _2fa "name: 2fa, nullable"\n');
  expect(diagram).toContain(
    '    integer manager_id FK "name: manager id, nullable"\n',
  );
  expect(diagram).toContain("  users |o..o{ people : manager\n");
  // A migration snapshot labels the edge with the column name: quoted.
  expect(
    renderMermaid(
      schemaGraph(migrationSnapshot(schema({ users, people }).$snapshot())),
      {
        compact: true,
      },
    ),
  ).toContain('  users |o..o{ people : "manager id"\n');

  // Every attribute line is `type name [keys] ["comment"]` with Mermaid words.
  for (const line of diagram
    .split("\n")
    .filter((entry) => entry.startsWith("    "))) {
    expect(line).toMatch(
      /^ {4}[A-Za-z_][A-Za-z0-9_()[\]-]* [A-Za-z_][A-Za-z0-9_()[\]-]*(?: (?:PK|FK|UK)(?:, (?:PK|FK|UK))*)?(?: "[^"]*")?$/,
    );
  }
});

test("a line break in a name, U+2028 and U+2029 too, is an escape that keeps the diagram's lines", () => {
  const odd = table({
    id: int.auto,
    a: text.named("one two"),
    b: text.named("three four"),
    owner: users.column("owner\nid"),
  });
  const diagram = renderMermaid(
    schemaGraph(
      migrationSnapshot(schema({ users, [`odd\rtable`]: odd }).$snapshot()),
    ),
  );

  expect(diagram).toContain('"name: one\\u2028two"');
  expect(diagram).toContain('"name: three\\u2029four"');
  expect(diagram).toContain('  "odd\\rtable" {\n');
  expect(diagram).toContain('  users ||..o{ "odd\\rtable" : "owner\\nid"\n');
  for (const breaking of ["\r", 0x2028, 0x2029]) {
    expect(diagram).not.toContain(
      typeof breaking === "number" ? String.fromCharCode(breaking) : breaking,
    );
  }
});
