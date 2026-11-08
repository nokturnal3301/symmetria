import { SQL } from "bun";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql as raw,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  type Generated,
} from "kysely";
import { jsonArrayFrom } from "kysely/helpers/postgres";
import { DATABASE_URL, POOL_SIZE } from "../config";
import type { Bench, Observer } from "./types";

type Database = {
  users: { id: number; email: string; name: string };
  posts: {
    id: Generated<number>;
    slug: string;
    title: string;
    author_id: number;
    editor_id: number | null;
    state: Generated<string>;
    views: Generated<bigint>;
    created_at: Generated<Date>;
  };
  tags: { id: number; label: string };
  post_tags: { post_id: number; tag_id: number };
};

/**
 * Minimal dialect over Bun.SQL. Queries go straight to the pool like the other
 * libraries do; transactions are not exercised by this benchmark.
 */
const bunDialect = (client: SQL, observe?: Observer): Dialect => {
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      observe?.({ sql: query.sql, parameters: query.parameters });
      const result = await client.unsafe(query.sql, [...query.parameters]);

      return {
        rows: Array.from(result) as R[],
        numAffectedRows: BigInt((result as { count?: number }).count ?? 0),
      };
    },
    streamQuery: () => {
      throw new Error("streaming is not part of the benchmark");
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {
      throw new Error("transactions are not part of the benchmark");
    },
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: () => client.close(),
  };

  return {
    createDriver: () => driver,
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: (db) => new PostgresIntrospector(db),
  };
};

export const create = (observe?: Observer): Bench => {
  const client = new SQL(DATABASE_URL, { max: POOL_SIZE, bigint: true });
  const db = new Kysely<Database>({ dialect: bunDialect(client, observe) });

  const nestedQuery = (offset: number, afterId?: number) =>
    db
      .selectFrom("users")
      .select(["users.id", "users.name"])
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom("posts")
            .select(["posts.title", raw<string>`posts.views::text`.as("views")])
            .select((inner) =>
              jsonArrayFrom(
                inner
                  .selectFrom("post_tags")
                  .innerJoin("tags", "tags.id", "post_tags.tag_id")
                  .select("tags.label")
                  .whereRef("post_tags.post_id", "=", "posts.id"),
              ).as("tags"),
            )
            .whereRef("posts.author_id", "=", "users.id")
            .orderBy("posts.created_at", "desc")
            .orderBy("posts.id", "desc")
            .limit(3),
        ).as("posts"),
      )
      .$if(afterId === undefined, (qb) => qb.offset(offset))
      .$if(afterId !== undefined, (qb) => qb.where("users.id", ">", afterId!))
      .orderBy("users.id")
      .limit(50);

  return {
    name: "Kysely",
    pointLookup: (id) =>
      db
        .selectFrom("users")
        .select(["id", "email", "name"])
        .where("id", "=", id)
        .executeTakeFirst(),
    listJoin: () =>
      db
        .selectFrom("posts")
        .innerJoin("users", "users.id", "posts.author_id")
        .select(["posts.id", "posts.title", "users.name as author"])
        .where("posts.state", "=", "published")
        .orderBy("posts.created_at", "desc")
        .orderBy("posts.id", "desc")
        .limit(20)
        .execute(),
    nested: (offset) => nestedQuery(offset).execute(),
    nestedKeyset: (afterId) => nestedQuery(0, afterId).execute(),
    insertOne: (row) =>
      db
        .insertInto("posts")
        .values({ slug: row.slug, title: row.title, author_id: row.authorId })
        .returning("id")
        .executeTakeFirst(),
    insertMany: (rows) =>
      db
        .insertInto("posts")
        .values(
          rows.map((row) => ({
            slug: row.slug,
            title: row.title,
            author_id: row.authorId,
          })),
        )
        .execute(),
    updateViews: (id) =>
      db
        .updateTable("posts")
        .set({ views: raw`views + 1` })
        .where("id", "=", id)
        .returning("views")
        .executeTakeFirst(),
    buildNested: (offset) => nestedQuery(offset).compile(),
    close: () => db.destroy(),
  };
};
