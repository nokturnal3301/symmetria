import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { eq, gt, desc, asc, relations, sql as raw } from "drizzle-orm";
import {
  pgTable,
  integer,
  text,
  bigint,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { DATABASE_URL, POOL_SIZE } from "../config";
import type { Bench, Observer } from "./types";

const users = pgTable("users", {
  id: integer().primaryKey().generatedByDefaultAsIdentity(),
  email: text().notNull().unique(),
  name: text().notNull(),
});
const posts = pgTable("posts", {
  id: integer().primaryKey().generatedByDefaultAsIdentity(),
  slug: text().notNull().unique(),
  title: text().notNull(),
  authorId: integer("author_id")
    .notNull()
    .references(() => users.id),
  editorId: integer("editor_id").references(() => users.id),
  state: text().notNull().default("draft"),
  views: bigint({ mode: "bigint" }).notNull().default(0n),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
const tags = pgTable("tags", {
  id: integer().primaryKey().generatedByDefaultAsIdentity(),
  label: text().notNull().unique(),
});
const postTags = pgTable(
  "post_tags",
  {
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.postId, table.tagId] })],
);
const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  postTags: many(postTags),
}));
const postTagsRelations = relations(postTags, ({ one }) => ({
  post: one(posts, { fields: [postTags.postId], references: [posts.id] }),
  tag: one(tags, { fields: [postTags.tagId], references: [tags.id] }),
}));
const tagsRelations = relations(tags, ({ many }) => ({
  postTags: many(postTags),
}));
const schema = {
  users,
  posts,
  tags,
  postTags,
  usersRelations,
  postsRelations,
  postTagsRelations,
  tagsRelations,
};

export const create = (observe?: Observer): Bench => {
  const client = new SQL(DATABASE_URL, { max: POOL_SIZE, bigint: true });
  const db = drizzle({
    client,
    schema,
    ...(observe
      ? {
          logger: {
            logQuery: (sql: string, parameters: unknown[]) =>
              observe({ sql, parameters }),
          },
        }
      : {}),
  });

  const nestedQuery = (offset: number, afterId?: number) =>
    db.query.users.findMany({
      columns: { id: true, name: true },
      offset: afterId === undefined ? offset : 0,
      where: afterId === undefined ? undefined : gt(users.id, afterId),
      orderBy: asc(users.id),
      limit: 50,
      with: {
        posts: {
          columns: { title: true },
          // JSON numeric parsing loses bigint precision. Match the lossless contract.
          extras: { views: raw<string>`${posts.views}::text`.as("views") },
          orderBy: [desc(posts.createdAt), desc(posts.id)],
          limit: 3,
          with: {
            postTags: {
              columns: {},
              with: { tag: { columns: { label: true } } },
            },
          },
        },
      },
    });

  return {
    name: "Drizzle",
    pointLookup: async (id) =>
      (
        await db
          .select({ id: users.id, email: users.email, name: users.name })
          .from(users)
          .where(eq(users.id, id))
      )[0],
    listJoin: () =>
      db
        .select({ id: posts.id, title: posts.title, author: users.name })
        .from(posts)
        .innerJoin(users, eq(users.id, posts.authorId))
        .where(eq(posts.state, "published"))
        .orderBy(desc(posts.createdAt), desc(posts.id))
        .limit(20),
    nested: (offset) => nestedQuery(offset),
    nestedKeyset: (afterId) => nestedQuery(0, afterId),
    insertOne: async (row) =>
      (await db.insert(posts).values(row).returning({ id: posts.id }))[0],
    insertMany: (rows) => db.insert(posts).values(rows),
    updateViews: async (id) =>
      (
        await db
          .update(posts)
          .set({ views: raw`${posts.views} + 1` })
          .where(eq(posts.id, id))
          .returning({ views: posts.views })
      )[0],
    buildNested: (offset) => {
      const { sql, params } = nestedQuery(offset).toSQL();

      return { sql, parameters: params };
    },
    close: () => client.close(),
  };
};
