// Node.js 24+ runs this file directly: `node examples/node/read.ts`.
// It uses the node-postgres adapter and the same query API as the Bun examples.
// Node resolves ESM imports with extensions, so the schema is declared inline.
import { createDatabase, schema, table, int, text } from "symmetria";
import { postgres } from "symmetria/pg";

const users = table({
  id: int.auto,
  email: text.unique,
  name: text,
});

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "Set DATABASE_URL to the example database (see examples/README.md).",
  );
}

const database = createDatabase({
  schema: schema({ users }),
  driver: postgres({ url, max: 2 }),
});

try {
  const authors = database.users(
    ({ id, name }) => ({
      id,
      name,
    }),
    {
      orderBy: ({ id }) => id.ascending,
      limit: 5,
    },
  );
  console.log(authors.toSQL().sql);
  console.log(`node ${process.version}:`, await authors);
} finally {
  await database.$close();
}
