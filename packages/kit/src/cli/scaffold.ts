/**
 * `symmetria init`: writes the starter schema, migrations directory and config
 * files for a new project. A schema module the project already has is
 * imported, not replaced.
 */
import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const USERS = "src/database/tables/users.ts";
const SCHEMA = "src/database/schema.ts";

/**
 * The scaffold as one set: each file that imports another one gets the import
 * clause that fits it (`{ appSchema }`, or the export an existing module has).
 */
const scaffold = (imports: { users: string; appSchema: string }) => ({
  [USERS]: `import { table, uuid, text } from "symmetria";\n\nexport const users = table({\n  id: uuid.v4.brand("UserId"),\n  email: text.unique,\n  name: text,\n});\n`,
  [SCHEMA]: `import { schema } from "symmetria";\nimport ${imports.users} from "./tables/users.ts";\n\nexport const appSchema = schema({ users });\n`,
  "src/database/index.ts": `import { createDatabase } from "symmetria";\nimport { postgres } from "symmetria/driver";\nimport ${imports.appSchema} from "./schema.ts";\n\nconst url = process.env.DATABASE_URL;\n\nif (!url) {\n  throw new Error("Set DATABASE_URL before connecting");\n}\n\nexport const db = createDatabase({\n  schema: appSchema,\n  driver: postgres({ url }),\n});\n`,
  "symmetria.config.ts": `import { defineMigrationConfig } from "symmetria-kit";\nimport ${imports.appSchema} from "./src/database/schema";\n\nexport default defineMigrationConfig({\n  schema: appSchema,\n  directory: "./migrations",\n  databaseUrl: process.env.DATABASE_URL,\n});\n`,
  ".env.example":
    "DATABASE_URL=postgres://postgres:postgres@localhost:5432/app\n",
});

const missing = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";

/** The text of a project file, or undefined when there is none. */
const projectFile = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch((error: unknown) => {
    if (missing(error)) {
      return undefined;
    }

    throw error;
  });

/** Words after which a `/` starts a regular expression, not a division. */
const BEFORE_REGEX =
  /(?:^|[^\w$.])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/**
 * A module's code without its comments, and with the contents of strings,
 * template literals and regular expressions blanked, so that a pattern sees
 * only code (`"tables/*.ts"` opens no comment, a string mentioning
 * `export const appSchema` exports nothing). Undefined when a comment or
 * literal does not end: the reader is then unsure.
 */
export const moduleCode = (source: string): string | undefined => {
  let code = "";
  let index = 0;
  // Open template literals, innermost last: for each, how many braces are
  // open inside its current `${…}`.
  const templates: number[] = [];
  // The last character of code, to tell a regular expression from a division.
  let last = "";

  /**
   * The position of the quote that ends a literal whose text starts at
   * `from` (in a template, or of a `${` that comes first), or -1.
   */
  const literalEnd = (quote: string, from: number, lines: boolean): number => {
    let position = from;

    while (position < source.length && source[position] !== quote) {
      if (quote === "`" && source.startsWith("${", position)) {
        return position;
      }

      if (source[position] === "\\") {
        position += 1;
      } else if (source[position] === "\n" && !lines) {
        return -1;
      }

      position += 1;
    }

    return position < source.length ? position : -1;
  };

  while (index < source.length) {
    const char = source[index]!;

    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);

      if (end < 0) {
        return undefined;
      }

      code += " ";
      index = end + 2;
    } else if (char === '"' || char === "'") {
      const end = literalEnd(char, index + 1, false);

      if (end < 0) {
        return undefined;
      }

      code += char + char;
      last = char;
      index = end + 1;
    } else if (char === "`" || (char === "}" && templates.at(-1) === 0)) {
      // A template's text, from its start or from the end of a `${…}`.
      // The `}` that ends a `${…}` stays, so the brackets still match.
      if (char === "}") {
        templates.pop();
        code += "}";
      }

      const end = literalEnd("`", index + 1, true);

      if (end < 0) {
        return undefined;
      }

      if (source[end] === "`") {
        code += "``";
        last = "`";
        index = end + 1;
      } else {
        templates.push(0);
        code += "`${";
        last = "{";
        index = end + 2;
      }
    } else if (
      char === "/" &&
      (last === "" ||
        /[(,=:[!&|?{};+\-*%<>~^]/.test(last) ||
        BEFORE_REGEX.test(code.trimEnd()))
    ) {
      let position = index + 1;
      let inClass = false;

      while (
        position < source.length &&
        (source[position] !== "/" || inClass)
      ) {
        if (source[position] === "\n") {
          return undefined;
        }

        if (source[position] === "\\") {
          position += 1;
        } else if (source[position] === "[") {
          inClass = true;
        } else if (source[position] === "]") {
          inClass = false;
        }

        position += 1;
      }

      if (position >= source.length) {
        return undefined;
      }

      code += "/ /";
      last = "/";
      index = position + 1;
    } else {
      if (templates.length && char === "{") {
        templates[templates.length - 1]! += 1;
      } else if (templates.length && char === "}") {
        templates[templates.length - 1]! -= 1;
      }

      code += char;
      last = /\s/.test(char) ? last : char;
      index += 1;
    }
  }

  return templates.length ? undefined : code;
};

/** A plain identifier, Unicode letters included. */
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;

/** Words that start a statement when a line begins with them. */
const STATEMENT_START =
  /^(?:export|import|const|let|var|function|async|class|abstract|type|interface|declare|enum|namespace|module|@)(?![\p{ID_Continue}$])/u;

/**
 * The top-level statements of module code (see moduleCode): split at `;` and
 * at a line that starts a declaration, outside brackets. What sits inside a
 * block (a namespace, `declare module`, a function) is not top level and stays
 * inside its statement. Undefined when the brackets do not match.
 */
const topLevelStatements = (code: string): string[] | undefined => {
  const statements: string[] = [];
  let depth = 0;
  let start = 0;

  const close = (end: number) => {
    const statement = code.slice(start, end).trim();

    if (statement) {
      statements.push(statement);
    }

    start = end + 1;
  };

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index]!;

    if ("([{".includes(char)) {
      depth += 1;
    } else if (")]}".includes(char)) {
      depth -= 1;

      if (depth < 0) {
        return undefined;
      }
    } else if (depth === 0 && char === ";") {
      close(index);
    } else if (
      depth === 0 &&
      char === "\n" &&
      STATEMENT_START.test(code.slice(index + 1).trimStart())
    ) {
      close(index);
    }
  }

  if (depth !== 0) {
    return undefined;
  }

  close(code.length);

  return statements;
};

/** Splits at commas outside brackets; `starts` keeps only commas a part may start after. */
const splitTopLevel = (
  text: string,
  starts: (rest: string) => boolean = () => true,
): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if ("([{".includes(char)) {
      depth += 1;
    } else if (")]}".includes(char)) {
      depth -= 1;
    } else if (depth === 0 && char === "," && starts(text.slice(index + 1))) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(text.slice(start).trim());

  return parts;
};

/** A declarator `name: Type = init`, split at its `=` (not `=>`, `==`, `<=`). */
const declarator = (
  text: string,
): { name: string; init: string | undefined } | undefined => {
  const name = /^[^\s:=!]+/u.exec(text)?.[0] ?? "";
  let depth = 0;

  if (!IDENTIFIER.test(name)) {
    return undefined;
  }

  for (let index = name.length; index < text.length; index += 1) {
    const char = text[index]!;

    if ("([{".includes(char)) {
      depth += 1;
    } else if (")]}".includes(char)) {
      depth -= 1;
    } else if (
      depth === 0 &&
      char === "=" &&
      !"=>".includes(text[index + 1] ?? "") &&
      !"=!<>".includes(text[index - 1] ?? "")
    ) {
      return { name, init: text.slice(index + 1).trim() };
    }
  }

  return { name, init: undefined };
};

/**
 * What a value expression is: exactly `builder(…)` (a `satisfies` or `as`
 * after it allowed), something else that calls the builder (a wrapper, an
 * object holding a schema: unsure), or another value.
 */
const valueKind = (
  init: string,
  builder: string,
): "builder" | "mentions" | "other" => {
  const call = new RegExp(`^${builder}\\s*\\(`).exec(init);

  if (call) {
    let depth = 0;

    for (let index = call[0].length - 1; index < init.length; index += 1) {
      if (init[index] === "(") {
        depth += 1;
      } else if (init[index] === ")" && --depth === 0) {
        const rest = init.slice(index + 1).trim();

        return /^(?:(?:as|satisfies)\s[^()]*)?$/s.test(rest)
          ? "builder"
          : "mentions";
      }
    }
  }

  return new RegExp(`(?:^|[^\\p{ID_Continue}$.])${builder}\\s*\\(`, "u").test(
    init,
  ) || new RegExp(`\\.\\s*${builder}\\s*\\(`).test(init)
    ? "mentions"
    : "other";
};

/**
 * How the scaffold imports `binding` from a module the project already has,
 * read from its code (it is not run). Only the plain top-level forms count:
 * a value exported as `binding` (`export const appSchema = …`, `export
 * function`, `export { s as appSchema }`), else the one `builder(…)` value the
 * module exports: `export const db = schema(…)`, `export { db }` /
 * `export { db as main }` of a top-level `const db = schema(…)`, `export
 * default schema(…)` or `export default db`. Anything it cannot read with
 * certainty (`export *`, re-exports, a schema inside an object or a wrapper,
 * several declarators with a schema, a local `schema`, more than one schema)
 * makes it unsure: undefined, and init creates nothing.
 */
export const importClause = (
  source: string,
  binding: string,
  builder: "schema" | "table",
): string | undefined => {
  const code = moduleCode(source);
  const statements = code === undefined ? undefined : topLevelStatements(code);

  if (code === undefined || statements === undefined) {
    return undefined;
  }

  // A `schema` of the module's own, or another name imported as `schema`.
  if (
    new RegExp(
      `(?:\\b(?:const|let|var|function|class)\\s+|\\bas\\s+)${builder}(?![\\p{ID_Continue}$])`,
      "u",
    ).test(code)
  ) {
    return undefined;
  }

  const builderLocals = new Set<string>();
  const typeNames = new Set<string>();
  let bindingExported = false;
  let unsure = false;
  const offers = new Map<string, string>();
  const lists: { local: string; exported: string }[] = [];
  let defaultIdentifier: string | undefined;

  const declarations = (text: string, exported: boolean) => {
    // A declarator starts with a name followed by `:`, `=`, `,` or the end;
    // a comma in `Map<string, number>` does not.
    const parts = splitTopLevel(text, (rest) =>
      /^\s*[\p{ID_Start}$_][\p{ID_Continue}$]*\s*(?:[:=,]|$)/u.test(rest),
    ).map(declarator);
    const built = parts.filter(
      (part) =>
        part?.init !== undefined && valueKind(part.init, builder) === "builder",
    );

    if (
      parts.some((part) => part === undefined) ||
      (built.length && parts.length > 1)
    ) {
      unsure ||= exported;

      return;
    }

    for (const part of parts) {
      const kind =
        part!.init === undefined ? "other" : valueKind(part!.init, builder);

      if (kind === "builder") {
        builderLocals.add(part!.name);
      }

      if (!exported) {
        continue;
      }

      if (kind === "mentions") {
        unsure = true;
      } else if (part!.name === binding) {
        bindingExported = true;
      } else if (kind === "builder") {
        offers.set(part!.name, `{ ${part!.name} as ${binding} }`);
      }
    }
  };

  for (const original of statements) {
    // A class's decorators are dropped.
    const statement = original.replace(/^(?:@[\w$.]+(?:\([^()]*\))?\s*)+/, "");
    const declared = /^(?:declare\s+)?(const|let|var)\s+([\s\S]*)$/.exec(
      statement,
    );
    const exported = /^export\s+([\s\S]*)$/.exec(statement);

    if (declared && !statement.startsWith("declare")) {
      declarations(declared[2]!, false);
      continue;
    }

    const typeDeclaration =
      /^(?:declare\s+)?(?:type|interface)\s+([\p{ID_Start}$_][\p{ID_Continue}$]*)/u.exec(
        statement,
      );

    if (typeDeclaration) {
      typeNames.add(typeDeclaration[1]!);
      continue;
    }

    if (!exported && !/^export\s*[{*=]/.test(statement)) {
      continue;
    }

    const rest = exported
      ? exported[1]!
      : statement.slice("export".length).trim();

    if (/^[*=]/.test(rest)) {
      // `export *` may bring any name; `export =` is not a module export.
      unsure = true;
    } else if (/^type\s*\{/.test(rest) || /^(?:type|interface)\s/.test(rest)) {
      const name =
        /^(?:type|interface)\s+([\p{ID_Start}$_][\p{ID_Continue}$]*)/u.exec(
          rest,
        )?.[1];

      if (name) {
        typeNames.add(name);
      }
    } else if (/^\{/.test(rest)) {
      const list = /^\{([^{}]*)\}\s*([\s\S]*)$/.exec(rest);

      if (!list || (list[2] && !/^from\s*""$/.test(list[2]))) {
        unsure = true;
        continue;
      }

      for (const entry of splitTopLevel(list[1]!).filter(Boolean)) {
        if (/^type\s/.test(entry)) {
          continue;
        }

        const [local, exportedName = local, extra] = entry.split(/\s+as\s+/);

        if (
          extra !== undefined ||
          !IDENTIFIER.test(local!) ||
          !(IDENTIFIER.test(exportedName!) || exportedName === "default")
        ) {
          unsure = true;
        } else if (list[2]) {
          // A re-export: only the binding itself is taken, as named.
          if (exportedName === binding) {
            bindingExported = true;
          } else {
            unsure = true;
          }
        } else {
          lists.push({ local: local!, exported: exportedName! });
        }
      }
    } else if (/^default\s/.test(rest) || rest === "default") {
      const value = rest.slice("default".length).trim();
      const kind = valueKind(value, builder);

      if (kind === "builder") {
        offers.set("<default>", binding);
      } else if (IDENTIFIER.test(value)) {
        defaultIdentifier = value;
      } else if (kind === "mentions") {
        unsure = true;
      }
    } else if (
      /^(?:declare\s|const\s+enum\s|enum\s|namespace\s|module\s)/.test(rest)
    ) {
      const name =
        /^(?:declare\s+(?:const\s+|let\s+|var\s+|function\s+|class\s+|enum\s+|namespace\s+|module\s+)?|const\s+enum\s+|enum\s+|namespace\s+|module\s+)([\p{ID_Start}$_][\p{ID_Continue}$]*)/u.exec(
          rest,
        )?.[1];

      // Ambient declarations hold no value; an enum or namespace of the
      // binding's name is a value, but not a schema.
      if (name === binding && !rest.startsWith("declare")) {
        unsure = true;
      }
    } else if (/^(?:const|let|var)\s/.test(rest)) {
      declarations(rest.replace(/^(?:const|let|var)\s+/, ""), true);
    } else {
      const name =
        /^(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|class)\s*([\p{ID_Start}$_][\p{ID_Continue}$]*)/u.exec(
          rest,
        )?.[1];

      if (name === binding) {
        bindingExported = true;
      } else if (name === undefined) {
        unsure = true;
      }
    }
  }

  for (const { local, exported } of lists) {
    if (exported === binding) {
      if (typeNames.has(local)) {
        continue;
      }

      bindingExported = true;
    } else if (builderLocals.has(local) && !offers.has(local)) {
      offers.set(
        local,
        exported === "default" ? binding : `{ ${exported} as ${binding} }`,
      );
    }
  }

  if (
    defaultIdentifier !== undefined &&
    builderLocals.has(defaultIdentifier) &&
    !offers.has(defaultIdentifier)
  ) {
    offers.set(defaultIdentifier, binding);
  }

  if (unsure) {
    return undefined;
  }

  if (bindingExported) {
    return `{ ${binding} }`;
  }

  return offers.size === 1 ? [...offers.values()][0] : undefined;
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

  // What the project already has decides what the scaffold imports, and the
  // whole set is settled before anything is written.
  const schemaSource = await projectFile(resolve(directory, SCHEMA));
  const usersSource =
    schemaSource === undefined
      ? await projectFile(resolve(directory, USERS))
      : undefined;
  const appSchema =
    schemaSource === undefined
      ? "{ appSchema }"
      : importClause(schemaSource, "appSchema", "schema");
  const users =
    usersSource === undefined
      ? "{ users }"
      : importClause(usersSource, "users", "table");

  if (!appSchema) {
    throw new Error(
      `symmetria: init found ${SCHEMA} but no schema it can import with certainty (an appSchema export, or the one schema(…) the module exports, by name or as its default); nothing was created. Export your schema as appSchema, or write symmetria.config.ts yourself: export default defineMigrationConfig({ schema, directory: "./migrations" })`,
    );
  }

  if (!users) {
    throw new Error(
      `symmetria: init found ${USERS} but no table it can import with certainty (a users export, or the one table(…) the module exports, by name or as its default); nothing was created. Export the table as users, or move the file away and run init again`,
    );
  }

  const files = Object.entries(scaffold({ users, appSchema })).filter(
    // The starter table only serves the starter schema.
    ([name]) => name !== USERS || schemaSource === undefined,
  );
  const created: string[] = [];

  try {
    for (const [name, contents] of files) {
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
