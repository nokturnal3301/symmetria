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

/** The DDL `prisma migrate` writes for a small blog schema. */
const PRISMA = [
  `CREATE TABLE "_prisma_migrations" ("id" VARCHAR(36) NOT NULL, "checksum" VARCHAR(64) NOT NULL, CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id"))`,
  `CREATE TABLE "User" ("id" SERIAL NOT NULL, "email" TEXT NOT NULL, "name" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id"))`,
  `CREATE TABLE "Post" ("id" SERIAL NOT NULL, "title" TEXT NOT NULL, "price" DECIMAL(65,30) NOT NULL, "quantity" INTEGER NOT NULL DEFAULT 1, "authorId" INTEGER NOT NULL, CONSTRAINT "Post_pkey" PRIMARY KEY ("id"))`,
  `CREATE UNIQUE INDEX "User_email_key" ON "User"("email")`,
  `CREATE INDEX "Post_authorId_idx" ON "Post"("authorId")`,
  `ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
  `CREATE VIEW "PostTotals" AS SELECT "authorId", sum("price" * "quantity") AS "total" FROM "Post" GROUP BY "authorId"`,
];

describe.skipIf(!url)("moving from Prisma", () => {
  test("pull keeps Prisma's names and every drift finding has a predicted fix", async () => {
    const namespace = `prisma_${randomUUID().replaceAll("-", "")}`;
    const directory = await migrationDirectory();
    const address = new URL(url!);
    address.searchParams.set("options", `-c search_path=${namespace}`);
    const driver = postgres({ url: address.toString(), max: 1 });
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

      for (const statement of PRISMA) {
        await run(statement);
      }

      const pulled = await pullSchema({
        execute: driver.execute,
        module: runtime,
      });

      expect(pulled.source).toContain('casing: "preserve"');
      expect(pulled.source).toContain('.named("User")');
      expect(pulled.source).toContain("author: user.index.onUpdate.cascade,");
      expect(pulled.source).toContain(
        "createdAt: timestamp(3).default(sql`CURRENT_TIMESTAMP`),",
      );
      expect(pulled.source).toContain("price: numeric(65, 30),");
      expect(
        pulled.warnings.map((warning) => String(warning.code)).sort(),
      ).toEqual(
        ["view", "migration-table", "serial", "serial", "unique-index"].sort(),
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
          "extra-table _prisma_migrations",
          "missing-constraint User User_email_key",
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

      // The pulled schema reads and writes the Prisma tables directly.
      const database = createDatabase({ schema: fixed, driver });
      const ada = await database.user
        .insert({
          email: "ada@example.com",
          updatedAt: new Date("2024-01-31T12:00:00.000Z"),
        })
        .returning((user: { id: unknown; createdAt: unknown }) => ({
          id: user.id,
          createdAt: user.createdAt,
        }));
      await database.post.insert([
        { title: "Typed SQL", price: "19.99", quantity: 3, authorId: ada.id },
        { title: "Relations", price: "5.50", authorId: ada.id },
      ]);

      expect(
        await database.user(
          (user: {
            email: unknown;
            post: (
              shape: (
                post: Record<string, { multiply: (o: unknown) => unknown }>,
              ) => unknown,
            ) => unknown;
          }) => ({
            email: user.email,
            posts: user.post((post) => ({
              title: post.title,
              total: post.quantity!.multiply(post.price),
            })),
          }),
        ),
      ).toEqual([
        {
          email: "ada@example.com",
          posts: [
            { title: "Typed SQL", total: "59.970000000000000000000000000000" },
            { title: "Relations", total: "5.500000000000000000000000000000" },
          ],
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
