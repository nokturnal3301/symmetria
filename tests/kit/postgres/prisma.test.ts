import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDatabase, databaseError } from "../../../packages/runtime/src";
import { postgres } from "../../support/postgres";
import { detectDrift, pullSchema } from "../../../packages/kit/src";
import { migrationDirectory } from "../../support/directories";

const url = process.env.SYMMETRIA_TEST_DATABASE_URL;
const runtime = resolve("packages/runtime/src/index.ts");

/**
 * The migration Prisma 7.10.1 writes for this schema, statement for statement:
 *
 *   enum Role { USER ADMIN }
 *   model User { id Int @id @default(autoincrement()); email String @unique; name String?
 *     role Role @default(USER); balance Decimal @db.Decimal(12, 2) @default(0)
 *     createdAt DateTime @default(now()); updatedAt DateTime @updatedAt; posts Post[]; profile Profile? }
 *   model Profile { id Int @id @default(autoincrement()); bio String; userId Int @unique
 *     user User @relation(fields: [userId], references: [id], onDelete: Cascade) }
 *   model Post { id String @id @default(uuid()); title String; views BigInt @default(0)
 *     published Boolean @default(false); authorId Int; author User @relation(...)
 *     categories Category[]; meta Json?; tags String[]; publishedAt DateTime? @db.Timestamptz(6)
 *     @@index([authorId, published]); @@map("posts") }
 *   model Category { id Int @id @default(autoincrement()); name String @unique @map("category_name"); posts Post[] }
 */
const PRISMA = [
  `CREATE TABLE "_prisma_migrations" ("id" VARCHAR(36) NOT NULL, "checksum" VARCHAR(64) NOT NULL, CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id"))`,
  `CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN')`,
  `CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE "Profile" (
    "id" SERIAL NOT NULL,
    "bio" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "views" BIGINT NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "authorId" INTEGER NOT NULL,
    "meta" JSONB,
    "tags" TEXT[],
    "publishedAt" TIMESTAMPTZ(6),
    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "category_name" TEXT NOT NULL,
    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE "_CategoryToPost" (
    "A" INTEGER NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_CategoryToPost_AB_pkey" PRIMARY KEY ("A","B")
  )`,
  `CREATE UNIQUE INDEX "User_email_key" ON "User"("email")`,
  `CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId")`,
  `CREATE INDEX "posts_authorId_published_idx" ON "posts"("authorId", "published")`,
  `CREATE UNIQUE INDEX "Category_category_name_key" ON "Category"("category_name")`,
  `CREATE INDEX "_CategoryToPost_B_index" ON "_CategoryToPost"("B")`,
  `ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  `ALTER TABLE "posts" ADD CONSTRAINT "posts_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
  `ALTER TABLE "_CategoryToPost" ADD CONSTRAINT "_CategoryToPost_A_fkey" FOREIGN KEY ("A") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  `ALTER TABLE "_CategoryToPost" ADD CONSTRAINT "_CategoryToPost_B_fkey" FOREIGN KEY ("B") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
  `CREATE VIEW "UserViews" AS SELECT "authorId", sum("views") AS "views" FROM "posts" GROUP BY "authorId"`,
];

/** Rows a running Prisma application has written: serial ids, an explicit id and a deleted row. */
const ROWS = [
  `INSERT INTO "User" ("email", "updatedAt") VALUES ('ada@example.com', now()), ('bob@example.com', now()), ('gone@example.com', now())`,
  `INSERT INTO "User" ("id", "email", "role", "updatedAt") VALUES (10, 'imported@example.com', 'ADMIN', now())`,
  `DELETE FROM "User" WHERE "email" = 'gone@example.com'`,
  `INSERT INTO "Category" ("category_name") VALUES ('news')`,
  `INSERT INTO "posts" ("id", "title", "authorId", "tags") VALUES ('p1', 'Typed SQL', 1, '{sql,types}')`,
  `INSERT INTO "_CategoryToPost" ("A", "B") VALUES (1, 'p1')`,
];

describe.skipIf(!url)("moving from Prisma", () => {
  test("pull declares a Prisma 7 database as it is, and drift lists only what pull announced", async () => {
    const namespace = `prisma_${randomUUID().replaceAll("-", "")}`;
    const directory = await migrationDirectory();
    const address = new URL(url!);
    address.searchParams.set("options", `-c search_path=${namespace}`);
    const driver = postgres({ url: address.toString(), max: 2 });
    const run = (statement: string) =>
      driver.execute({ sql: statement, parameters: [] });
    const describeFindings = (
      findings: Awaited<ReturnType<typeof detectDrift>>,
    ) =>
      findings
        .map((finding) =>
          `${finding.kind} ${finding.table} ${finding.expected ?? finding.actual ?? ""}`.trim(),
        )
        .sort();

    try {
      await run(`CREATE SCHEMA "${namespace}"`);

      for (const statement of [...PRISMA, ...ROWS]) {
        await run(statement);
      }

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });

      expect(pulled.source).toContain('casing: "preserve"');
      expect(pulled.source).toContain('.named("User")');
      // Prisma's enum keeps its name, so the Prisma client keeps working.
      expect(pulled.source).toContain(
        'role: oneOf("USER", "ADMIN").typeName("Role").default("USER"),',
      );
      expect(pulled.enumerations).toEqual(["Role"]);
      expect(pulled.source).toContain('balance: numeric(12, 2).default("0"),');
      expect(pulled.source).toContain(
        "createdAt: timestamp(3).default(sql`CURRENT_TIMESTAMP`),",
      );
      expect(pulled.source).toContain("updatedAt: timestamp(3),");
      expect(pulled.source).toContain("views: bigint.default(0n),");
      expect(pulled.source).toContain("meta: jsonb<unknown>().nullable,");
      expect(pulled.source).toContain("tags: text.array.nullable,");
      expect(pulled.source).toContain("publishedAt: timestamptz(6).nullable,");
      expect(pulled.source).toContain(
        'categoryName: text.named("category_name").unique,',
      );
      expect(pulled.source).toContain(
        "user: user.unique.onDelete.cascade.onUpdate.cascade,",
      );
      expect(pulled.source).toContain("author: user.onUpdate.cascade,");
      expect(pulled.source).toContain(
        "categoryToPost: ({ category, posts }) =>",
      );
      expect(pulled.source).toContain(
        'a: category.column("A").onDelete.cascade.onUpdate.cascade,',
      );
      expect(pulled.source).toContain(
        "_CategoryToPost_B_index: index(categoryToPost.bId),",
      );
      expect(pulled.source).toContain(
        "posts_authorId_published_idx: index(posts.authorId, posts.published),",
      );
      expect(
        pulled.warnings.map((warning) => String(warning.code)).sort(),
      ).toEqual(
        [
          "view",
          "migration-table",
          "serial",
          "serial",
          "serial",
          "unique-index",
          "unique-index",
          "unique-index",
          // Prisma names the junction's key `_CategoryToPost_AB_pkey`.
          "constraint-name",
        ].sort(),
      );
      expect(
        pulled.warnings.find((warning) => warning.code === "constraint-name")
          ?.fix,
      ).toBe(
        'ALTER TABLE "_CategoryToPost" RENAME CONSTRAINT "_CategoryToPost_AB_pkey" TO "_CategoryToPost_pkey";',
      );

      const path = join(directory, "schema.ts");
      await writeFile(path, pulled.source);
      const { appSchema } = await import(pathToFileURL(path).href);

      // Each remaining difference was announced by a warning.
      expect(
        describeFindings(
          await detectDrift({
            execute: driver.execute,
            snapshot: appSchema.$snapshot(),
          }),
        ),
      ).toEqual(
        [
          "extra-index User User_email_key",
          "missing-constraint User User_email_key",
          "extra-index Profile Profile_userId_key",
          "missing-constraint Profile Profile_userId_key",
          "extra-index Category Category_category_name_key",
          "missing-constraint Category Category_category_name_key",
          "extra-constraint _CategoryToPost _CategoryToPost_AB_pkey",
          "missing-constraint _CategoryToPost _CategoryToPost_pkey",
          "extra-table _prisma_migrations",
        ].sort(),
      );

      // The suggested fixes leave only Prisma's own history table.
      for (const fix of pulled.warnings.flatMap((warning) =>
        warning.fix ? [warning.fix] : [],
      )) {
        await run(fix);
      }

      const repulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });
      expect(
        repulled.warnings.map((warning) => String(warning.code)).sort(),
      ).toEqual(["migration-table", "view"]);
      expect(repulled.source).toContain("id: int.auto.byDefault,");

      const fixedPath = join(directory, "schema-fixed.ts");
      await writeFile(fixedPath, repulled.source);
      const { appSchema: fixed } = await import(pathToFileURL(fixedPath).href);

      expect(
        describeFindings(
          await detectDrift({
            execute: driver.execute,
            snapshot: fixed.$snapshot(),
          }),
        ),
      ).toEqual(["extra-table _prisma_migrations"]);

      // The pulled schema reads and writes the tables Prisma already filled:
      // identities continue after the highest id, and explicit ids still work.
      const database = createDatabase({ schema: fixed, driver });
      const created = await database.user
        .insert({
          email: "eve@example.com",
          role: "ADMIN",
          updatedAt: new Date("2024-01-31T12:00:00.000Z"),
        })
        .returning((user: { id: unknown; role: unknown }) => ({
          id: user.id,
          role: user.role,
        }));
      expect(created).toEqual({ id: 11, role: "ADMIN" });
      await database.user.insert({
        id: 20,
        email: "chosen@example.com",
        updatedAt: new Date(),
      });
      await database.posts.insert({
        id: "p2",
        title: "Relations",
        authorId: created.id,
        tags: ["prisma"],
      });
      await database.categoryToPost.insert({ aId: 1, bId: "p2" });

      expect(
        await database.user(
          (user: {
            email: unknown;
            posts: (
              shape: (post: Record<string, unknown>) => unknown,
            ) => unknown;
          }) => ({
            email: user.email,
            posts: user.posts((post) => ({
              title: post.title,
              tags: post.tags,
            })),
          }),
          {
            where: (user: { role: { is: (role: string) => unknown } }) =>
              user.role.is("ADMIN"),
          },
        ),
      ).toEqual([
        { email: "imported@example.com", posts: [] },
        {
          email: "eve@example.com",
          posts: [{ title: "Relations", tags: ["prisma"] }],
        },
      ]);
      expect(
        await database.category(
          (category: {
            categoryName: unknown;
            posts: (
              shape: (post: Record<string, unknown>) => unknown,
            ) => unknown;
          }) => ({
            name: category.categoryName,
            posts: category.posts((post) => ({ title: post.title })),
          }),
        ),
      ).toEqual([
        {
          name: "news",
          posts: [{ title: "Typed SQL" }, { title: "Relations" }],
        },
      ]);

      const duplicate = await database.user
        .insert({ email: "ada@example.com", updatedAt: new Date() })
        .execute()
        .catch((error: unknown) => error);
      expect(databaseError(duplicate)).toMatchObject({
        kind: "unique",
        table: "User",
        constraint: "User_email_key",
      });
    } finally {
      await run(`DROP SCHEMA "${namespace}" CASCADE`);
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
