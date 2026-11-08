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
    posts_state_enum state
    numeric(12_2) price
    timestamptz published_at "nullable"
    integer author_id FK
    integer editor_id FK "nullable"
  }
  profiles {
    text bio "nullable"
    integer user_id FK, UK
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
