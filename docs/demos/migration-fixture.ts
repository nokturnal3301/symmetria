import assert from "node:assert/strict";
import { SQL } from "bun";
import { schema, table, int, text, bool, index } from "symmetria";
import { defineMigrationConfig } from "symmetria-kit";

const variant = process.env.MODEL ?? "base";
const model = schema({
  users:
    variant === "indexed"
      ? table({ id: int.auto, email: text.nullable }).indexes((user) => ({
          email: index(user.email).unique,
        }))
      : variant === "renamed"
        ? table({ id: int.auto, mail: text.nullable })
        : variant === "removed"
          ? table({ id: int.auto })
          : variant === "active"
            ? table({
                id: int.auto,
                email: text.nullable,
                active: bool.default(true),
              })
            : table({ id: int.auto, email: text.nullable }),
});

export default defineMigrationConfig({
  schema: model,
  directory: "./migrations",
  databaseUrl: process.env.DEMO_DATABASE_URL,
  verificationDatabaseUrl: process.env.DEMO_DATABASE_URL!,
  metadataSchema: "meta",
  verify: {
    beforeMigration: async ({ driver, migration, phase }) => {
      if (
        process.env.DEMO_VERIFY_DATA &&
        migration.endsWith("_add_active") &&
        phase === "up"
      ) {
        await driver.execute({
          sql: "INSERT INTO users (email) VALUES ($1)",
          parameters: ["ada@example.com"],
        });
      }
    },
    afterMigration: async ({ driver, migration, phase }) => {
      if (process.env.DEMO_VERIFY_DATA && migration.endsWith("_add_active")) {
        const result = await driver.execute({
          sql: "SELECT email FROM users",
          parameters: [],
        });
        const rows = Array.isArray(result) ? result : result.rows;
        assert.deepEqual(rows, [{ email: "ada@example.com" }]);
        console.log(`Data check [${phase}]: existing user retained.`);
      }
    },
  },
});

if (import.meta.main) {
  const client = new SQL(process.env.DEMO_DATABASE_URL!);

  try {
    switch (process.argv[2]) {
      case "seed":
        await client`INSERT INTO users (email) VALUES ('ada@example.com')`;
        break;
      case "duplicates":
        await client`INSERT INTO users (email) VALUES ('ada@example.com'), ('ada@example.com')`;
        break;
      case "users": {
        const rows = await client`SELECT * FROM users ORDER BY id`;
        assert.equal(rows.length, 1);
        console.log(JSON.stringify(rows[0]));
        break;
      }
      case "drift":
        await client`ALTER TABLE users ALTER COLUMN active DROP DEFAULT`;
        console.log("ALTER TABLE users ALTER COLUMN active DROP DEFAULT;");
        break;
      case "restore":
        await client`ALTER TABLE users ALTER COLUMN active SET DEFAULT TRUE`;
        console.log("ALTER TABLE users ALTER COLUMN active SET DEFAULT TRUE;");
        break;
      case "reconcile": {
        const deleted =
          await client`DELETE FROM users duplicate USING users retained WHERE duplicate.email = retained.email AND duplicate.id > retained.id`;
        assert.equal(deleted.count, 1);
        console.log(
          `Removed ${deleted.count} duplicate row; retained the original user.`,
        );
        await client`DROP INDEX CONCURRENTLY users_email_idx`;
        console.log("DROP INDEX CONCURRENTLY users_email_idx;");
        break;
      }
      default:
        throw new Error(
          "Expected seed, duplicates, users, drift, restore or reconcile",
        );
    }
  } finally {
    await client.close();
  }
}
