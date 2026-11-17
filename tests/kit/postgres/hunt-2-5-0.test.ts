import { describe, expect, test } from "bun:test";
import { schema, table, int, text } from "../../../packages/runtime/src";
import {
  embedder,
  fullText,
} from "../../../packages/runtime/src/entries/search";
import { detectDrift, diffSchemas } from "../../../packages/kit/src";
import { testDatabase } from "../../support/postgres";
import { hasExtension } from "../../support/extensions";

const databaseUrl = process.env.SYMMETRIA_TEST_DATABASE_URL;
const withVector = await hasExtension(databaseUrl, "vector");

const four = embedder(4, async (texts) => texts.map(() => [1, 0, 0, 0]));
const eight = embedder(8, async (texts) =>
  texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
);

describe.skipIf(!databaseUrl)(
  "migrations fixed after the 2.5.0 bug hunt",
  () => {
    test("a column a full-text search read can be dropped", async () => {
      const before = schema({
        documents: table({ id: int.auto, title: text, body: text }).search(
          (document) => ({
            about: { words: fullText([document.title, document.body]) },
          }),
        ),
      });
      const after = schema({
        documents: table({ id: int.auto, title: text }).search((document) => ({
          about: { words: fullText([document.title]) },
        })),
      });
      const isolated = await testDatabase({
        url: databaseUrl!,
        schema: before,
        prefix: "symmetria_hunt25_kit",
        max: 1,
      });
      const run = async (sql: string) => {
        const result = await isolated.driver.execute({ sql, parameters: [] });

        return Array.isArray(result) ? result : result.rows;
      };

      try {
        await isolated.database.documents.insert({
          title: "garage keys",
          body: "on the shelf",
        });

        const plan = diffSchemas(before.$snapshot(), after.$snapshot());

        for (const statement of plan.up) {
          await run(statement);
        }

        expect(
          await detectDrift({
            execute: isolated.driver.execute,
            snapshot: after.$snapshot(),
          }),
        ).toEqual([]);
        expect(
          await run(
            `SELECT count(*)::int AS found FROM documents WHERE about_words @@ plainto_tsquery('simple', 'garage')`,
          ),
        ).toEqual([{ found: 1 }]);

        for (const statement of plan.down) {
          // The dropped column comes back empty; the test table has one row.
          await run(
            statement.includes("SET NOT NULL")
              ? `UPDATE documents SET body = ''; ${statement}`
              : statement,
          );
        }

        expect(
          await detectDrift({
            execute: isolated.driver.execute,
            snapshot: before.$snapshot(),
          }),
        ).toEqual([]);
      } finally {
        await isolated.close();
      }
    });

    test.skipIf(!withVector)(
      "a model of another length migrates a table that has embeddings",
      async () => {
        const declared = (model: typeof four) =>
          schema({
            documents: table({ id: int.auto, body: text }).search(
              (document) => ({ about: { meaning: model(document.body) } }),
            ),
          });
        const before = declared(four);
        const after = declared(eight);
        const isolated = await testDatabase({
          url: databaseUrl!,
          schema: before,
          prefix: "symmetria_hunt25_kit",
          max: 1,
          searchPath: ["public"],
        });
        const run = async (sql: string) => {
          const result = await isolated.driver.execute({ sql, parameters: [] });

          return Array.isArray(result) ? result : result.rows;
        };

        try {
          await isolated.database.documents.insert({ body: "garage keys" });

          for (const statement of diffSchemas(
            before.$snapshot(),
            after.$snapshot(),
          ).up) {
            await run(statement);
          }

          // The embedding of the old length is gone; the row is not.
          expect(
            await run("SELECT body, about IS NULL AS cleared FROM documents"),
          ).toEqual([{ body: "garage keys", cleared: true }]);
          expect(
            await detectDrift({
              execute: isolated.driver.execute,
              snapshot: after.$snapshot(),
            }),
          ).toEqual([]);
        } finally {
          await isolated.close();
        }
      },
    );
  },
);
