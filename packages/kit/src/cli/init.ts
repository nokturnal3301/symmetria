import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const files: Readonly<Record<string, string>> = {
  "src/database/tables/users.ts": `import { table, uuid, text } from "symmetria";\n\nexport const users = table({\n  id: uuid.v4.brand("UserId"),\n  email: text.unique,\n  name: text,\n});\n`,
  "src/database/schema.ts": `import { schema } from "symmetria";\nimport { users } from "./tables/users";\n\nexport const appSchema = schema({ users });\n`,
  "src/database/index.ts": `import { createDatabase } from "symmetria";\nimport { postgres } from "symmetria/driver";\nimport { appSchema } from "./schema";\n\nconst url = process.env.DATABASE_URL;\n\nif (!url) {\n  throw new Error("Set DATABASE_URL before connecting");\n}\n\nexport const db = createDatabase({\n  schema: appSchema,\n  driver: postgres(url),\n});\n`,
  "symmetria.config.ts": `import { defineMigrationConfig } from "symmetria-kit";\nimport { appSchema } from "./src/database/schema";\n\nexport default defineMigrationConfig({\n  schema: appSchema,\n  directory: "./migrations",\n  databaseUrl: process.env.DATABASE_URL,\n});\n`,
  ".env.example":
    "DATABASE_URL=postgres://postgres:postgres@localhost:5432/app\n",
};

export const initializeProject = async (
  directory: string,
): Promise<string[]> => {
  // A configured project already owns its schema layout. Do not add a second one.
  for (const name of ["symmetria.config.ts", "migrations.config.ts"]) {
    const existing = await lstat(resolve(directory, name)).catch(
      (error: unknown) => {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }

        throw error;
      },
    );

    if (existing) {
      return [];
    }
  }

  const migrations = await readdir(resolve(directory, "migrations"), {
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  });

  if (
    migrations.some(
      (entry) => entry.isDirectory() && /^\d{6}_/.test(entry.name),
    )
  ) {
    return [];
  }

  const created: string[] = [];

  try {
    for (const [name, contents] of Object.entries(files)) {
      const path = resolve(directory, name);
      await mkdir(dirname(path), { recursive: true });
      const file = await open(path, "wx").catch((error: unknown) => {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          return undefined;
        }

        throw error;
      });

      if (!file) {
        continue;
      }

      created.push(name);

      try {
        await file.writeFile(contents);
      } finally {
        await file.close();
      }
    }

    return created;
  } catch (error) {
    await Promise.all(created.map((name) => rm(resolve(directory, name))));
    throw new Error(
      "symmetria: init could not create the project files (existing files are preserved)",
      { cause: error },
    );
  }
};
