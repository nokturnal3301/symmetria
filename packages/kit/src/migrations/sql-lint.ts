/**
 * Lints migration SQL for statements that lock or rewrite large tables, anonymous constraints and
 * volatile defaults, with safer rewrites. Every ALTER TABLE action is reviewed on its own, and
 * comments, string literals and function bodies never take part in the classification.
 */
import { parseMigrationSQL } from "./sql";
import type { LintFinding } from "./lint";

export type SQLFinding = LintFinding & { readonly statement: number };

/**
 * The comment generate writes before a statement that loses data (a
 * narrowing type change, cleared embeddings, removed enum labels), which the
 * SQL alone does not show: lint of the saved file rates it as generate did.
 */
export const DESTRUCTIVE_NOTE = "-- symmetria: destructive:";
const DESTRUCTIVE_LINE = /^--\s*symmetria:\s*destructive:\s*(.*)/;
/**
 * The comment generate writes before a statement that SQL alone would rate
 * higher than it is: an index, constraint or type that is no longer declared
 * (dropping it loses no data), a primary key rebuilt over columns that
 * contain the key that held, a foreign key rebuilt to change only its
 * actions. Lint of the saved file rates the statement a caution, as generate
 * did; the note counts only on such statements, never on one that drops a
 * table or column or changes values.
 */
export const CAUTION_NOTE = "-- symmetria: caution:";
const CAUTION_LINE = /^--\s*symmetria:\s*caution:\s*(.*)/;

/**
 * The text of the first note of a kind among a statement's comment lines:
 * never one inside a string or a quoted name, whose line break and
 * `-- symmetria: …` would otherwise rate the statement.
 */
const noteText = (
  lineComments: readonly string[],
  note: RegExp,
): string | undefined => {
  for (const comment of lineComments) {
    const found = note.exec(comment);

    if (found) {
      return found[1]!;
    }
  }

  return undefined;
};

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const TABLE_NAME = String.raw`(${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?)`;
const CREATED_TABLE = new RegExp(
  String.raw`^\s*CREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE_NAME}`,
  "i",
);
const TARGET_TABLE = new RegExp(
  String.raw`^\s*(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}\s+)?ON\s+(?:ONLY\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?)${TABLE_NAME}`,
  "i",
);
const ALTER_TABLE = new RegExp(
  String.raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE_NAME}\s*\*?\s*([\s\S]*)$`,
  "i",
);
const CREATED_INDEX = new RegExp(
  String.raw`^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENTIFIER})\s+ON\b`,
  "i",
);
// A CREATE INDEX that does nothing when the name is taken: no proof that the
// index it names is new.
const IF_NOT_EXISTS_INDEX =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\b/i;
// One name, possibly qualified, as an entry of a list of names.
const OBJECT_NAME = new RegExp(String.raw`^${TABLE_NAME}$`);
// Every index a DROP INDEX names, the list included.
const DROPPED_INDEXES =
  /^\s*DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([\s\S]*?)\s*(?:CASCADE|RESTRICT)?\s*$/i;
const DROPPED_INDEX = new RegExp(
  String.raw`^\s*DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?)\s*(?:CASCADE|RESTRICT)?\s*$`,
  "i",
);
const RENAME = /^RENAME\b/i;
const RENAMED_OBJECT = new RegExp(
  String.raw`^\s*ALTER\s+(?:INDEX|TYPE)\s+(?:IF\s+EXISTS\s+)?${TABLE_NAME}\s+RENAME\b`,
  "i",
);
const NAMED_CONSTRAINT = new RegExp(
  String.raw`^ADD\s+CONSTRAINT\s+(${IDENTIFIER})`,
  "i",
);
const DROPPED_CONSTRAINT = new RegExp(
  String.raw`^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${IDENTIFIER})\s*(?:CASCADE|RESTRICT)?\s*$`,
  "i",
);
const ADDED_COLUMN = new RegExp(
  String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENTIFIER})\s+([\s\S]*)$`,
  "i",
);
const ALTERED_COLUMN = new RegExp(
  String.raw`^ALTER\s+(?:COLUMN\s+)?(${IDENTIFIER})\s+([\s\S]*)$`,
  "i",
);
const KEY_COLUMNS = /\b(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY)\s*\(([^)]*)\)/i;
// The plain column list of a CREATE INDEX: `ON t [USING method] (a, b)`.
const INDEX_COLUMNS = new RegExp(
  String.raw`\bON\s+(?:ONLY\s+)?${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?\s*(?:USING\s+\w+\s*)?\((\s*${IDENTIFIER}\s*(?:,\s*${IDENTIFIER}\s*)*)\)`,
  "i",
);
// An explicit cast to a length-limited string type cuts long values instead
// of failing, however the type name is spelled (quoted, in pg_catalog).
const TRUNCATING_CAST =
  /\bUSING\b[\s\S]*(?:::\s*|\bAS\s+)(?:"?pg_catalog"?\s*\.\s*)?(?:"(?:varchar|bpchar|char)"|varchar|character\s+varying|char|character|bpchar)\s*\(\s*\d+\s*\)/i;
// A type name: quoted, in pg_catalog, of several words, with a modifier or as an array.
const TYPE_NAME = String.raw`(?:"(?:[^"]|"")+"(?:\s*\.\s*"(?:[^"]|"")+")?|(?:pg_catalog\s*\.\s*)?(?:double\s+precision|character\s+varying|bit\s+varying|(?:timestamp|time)(?:\s*\(\s*\d+\s*\))?\s+with(?:out)?\s+time\s+zone|[a-z_][a-z0-9_]*))(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\s*\[\s*\])*`;
// A constant: NULL, a boolean, a number, a literal (blanked to '') or a typed
// literal (`interval '1 day'`), cast or not, in parentheses or not.
const CONSTANT = String.raw`(?:NULL|TRUE|FALSE|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|(?:E|U&)?''|${TYPE_NAME}\s+'')`;
const CONSTANT_VALUE = String.raw`(?:\(\s*${CONSTANT}\s*\)|${CONSTANT}|CAST\s*\(\s*${CONSTANT}\s+AS\s+${TYPE_NAME}\s*\))(?:\s*::\s*${TYPE_NAME})*`;
// `USING NULL`, or any other constant as the whole expression (`USING 0`,
// `USING '{}'::jsonb`), gives every row the same value. A column compared
// with a literal (`USING at AT TIME ZONE 'UTC'`, `flag LIKE 'y%'`) is no constant.
const EMPTYING_CAST = new RegExp(
  String.raw`\bUSING\s+(?:\(\s*${CONSTANT_VALUE}\s*\)|${CONSTANT_VALUE})\s*$`,
  "i",
);
// What leaves the values of a table's existing rows as they are, so what
// lint knows of columns added earlier still holds: statements other than
// ALTER TABLE, ALTER TABLE actions, and column changes. Anything else (an
// UPDATE, INSERT, DO, a type change with USING, a function call) may write.
const KEEPS_VALUES =
  /^(?:CREATE (?:UNIQUE )?INDEX|DROP INDEX|CREATE (?:(?:GLOBAL |LOCAL )?(?:TEMP |TEMPORARY |UNLOGGED ))?TABLE(?!.* AS\b)|CREATE (?:TYPE|EXTENSION|SCHEMA|SEQUENCE)|ALTER (?:TYPE|INDEX|SEQUENCE)|DROP (?:TYPE|SEQUENCE)|COMMENT|GRANT|REVOKE|SET (?:SESSION |LOCAL )?TIME ?ZONE|RESET TIME ?ZONE|ANALYZE)\b/;
const KEEPS_TABLE_VALUES =
  /^(?:ADD|DROP|VALIDATE CONSTRAINT|RENAME|SET|RESET|ENABLE|DISABLE|OWNER TO|CLUSTER ON|REPLICA IDENTITY|NO FORCE|FORCE)\b/;
const KEEPS_COLUMN_VALUES =
  /^(?:SET DEFAULT|DROP DEFAULT|SET NOT NULL|DROP NOT NULL|SET STATISTICS|SET STORAGE|SET COMPRESSION|ADD GENERATED|SET GENERATED|SET INCREMENT|SET START|SET (?:NO )?(?:MINVALUE|MAXVALUE|CYCLE)|RESTART|DROP IDENTITY)\b/;
/** Functions evaluated for each row (their values may still repeat). */
export const VOLATILE_FUNCTION =
  /\b(?:CLOCK_TIMESTAMP|TIMEOFDAY|RANDOM|RANDOM_NORMAL|GEN_RANDOM_UUID|GEN_RANDOM_BYTES|UUIDV4|UUIDV7|UUID_GENERATE_V1|UUID_GENERATE_V1MC|UUID_GENERATE_V4|NEXTVAL)\b/i;
// Defaults evaluated per row: PostgreSQL 11+ stores constant and STABLE
// defaults (now(), transaction_timestamp()) without rewriting the table.
const VOLATILE_DEFAULT = new RegExp(
  String.raw`\bDEFAULT\b.*${VOLATILE_FUNCTION.source}`,
);
// Values PostgreSQL computes for every existing row of an added column.
const GENERATED_VALUES =
  /\b(?:GENERATED\b.*\b(?:IDENTITY|STORED)|(?:SMALL|BIG)?SERIAL)\b/;
const SERIAL_VALUES = /\b(?:GENERATED\b.*\bIDENTITY|(?:SMALL|BIG)?SERIAL)\b/;
// The defaults that give every row its own value: a sequence and the uuid
// generators, as the whole expression. clock_timestamp(), timeofday() and
// random() are evaluated per row too, but their values repeat (many rows fall
// within one microsecond), so a key over them can fail.
const DISTINCT_CALL = String.raw`(?:"?(?:public|pg_catalog)"?\s*\.\s*)?(?:gen_random_uuid|uuidv4|uuidv7|uuid_generate_v1|uuid_generate_v1mc|uuid_generate_v4|nextval)\s*\([^()]*\)(?:\s*::\s*[a-z_][\w ]*?)?`;
const DISTINCT_EXPRESSION = new RegExp(
  String.raw`^\s*\(?\s*${DISTINCT_CALL}\s*\)?\s*$`,
  "i",
);
const DISTINCT_DEFAULT = new RegExp(
  String.raw`\bDEFAULT\s+\(?\s*${DISTINCT_CALL}\s*\)?\s*(?:$|NOT\s+NULL\b|NULL\b|PRIMARY\s+KEY\b|UNIQUE\b|CONSTRAINT\b|CHECK\b|REFERENCES\b|COLLATE\b)`,
  "i",
);

/** A default that gives every existing row its own value (`gen_random_uuid()`, `nextval(…)`). */
export const distinctDefault = (expression: string): boolean =>
  DISTINCT_EXPRESSION.test(expression);
// The statements generate writes a caution note above, and only those: a
// drop of one index or type, and an ALTER TABLE of one action that drops a
// constraint, or adds a primary or foreign key after a constraint of the
// table was dropped earlier in the migration. A note anywhere else is a comment.
const NOTED_DROP = new RegExp(
  String.raw`^\s*DROP\s+(?:INDEX\s+(?:CONCURRENTLY\s+)?|TYPE\s+)(?:IF\s+EXISTS\s+)?${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?\s*(?:RESTRICT\s*)?$`,
  "i",
);
const NOTED_KEY = new RegExp(
  String.raw`^ADD\s+CONSTRAINT\s+(${IDENTIFIER})\s+(?:PRIMARY\s+KEY\s*\([^()]*\)|FOREIGN\s+KEY\s*\([^()]*\)\s*REFERENCES\s+${TABLE_NAME}\s*\([^()]*\)(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT))*)\s*$`,
  "i",
);
const RENAMED_TABLE = new RegExp(
  String.raw`^RENAME\s+TO\s+(${IDENTIFIER})\s*$`,
  "i",
);
// A CHECK that a column is not NULL, which SET NOT NULL can use once it is
// valid instead of scanning the table (--online writes one).
const NOT_NULL_CHECK = new RegExp(
  String.raw`^ADD\s+CONSTRAINT\s+(${IDENTIFIER})\s+CHECK\s*\(\s*\(?\s*(${IDENTIFIER})\s+IS\s+NOT\s+NULL\s*\)?\s*\)\s*(NOT\s+VALID\s*)?$`,
  "i",
);
// A column renamed or dropped takes its CHECK (column IS NOT NULL) along.
const RENAMED_COLUMN = new RegExp(
  String.raw`^RENAME\s+(?:COLUMN\s+)?(?!(?:CONSTRAINT|TO)\s)(${IDENTIFIER})\s+TO\s+(${IDENTIFIER})\s*$`,
  "i",
);
const DROPPED_COLUMN = new RegExp(
  String.raw`^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(?!CONSTRAINT\s)(${IDENTIFIER})(?:\s+(?:CASCADE|RESTRICT))?\s*$`,
  "i",
);
const VALIDATED_CONSTRAINT = new RegExp(
  String.raw`^VALIDATE\s+CONSTRAINT\s+(${IDENTIFIER})\s*$`,
  "i",
);
const RENAMED_CONSTRAINT = new RegExp(
  String.raw`^RENAME\s+CONSTRAINT\s+(${IDENTIFIER})\s+TO\s+(${IDENTIFIER})\s*$`,
  "i",
);
// What changes where unqualified names resolve: search_path (`SET SCHEMA` is
// its other name), and the role, whose "$user" schema the default path starts with.
const SETS_PATH =
  /^(?:(?:SET|RESET)\s+(?:(?:SESSION|LOCAL)\s+)?(?:search_path|"search_path"|schema|role|"role"|authorization|all)(?![\w$.])|DISCARD\s+ALL\b)/i;
const SET_CONFIG = /\bset_config\s*\(\s*((?:E|U&)\s*)?('')?/gi;
/** The settings set_config() changes name resolution with. */
const PATH_SETTINGS = new Set(["search_path", "role", "session_authorization"]);
/**
 * Statements that run code lint cannot read: a DO block, a procedure, a
 * prepared statement. They may change search_path or the role, and drop,
 * create or rename any object.
 */
const OPAQUE = /^\s*(?:DO|CALL|EXECUTE)\b/i;
/**
 * Statements that store code without running it (a view's query, a function
 * or rule body, a policy or trigger condition): a set_config() in them
 * changes no setting of this session.
 */
const STORES_CODE =
  /^\s*(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY)\s+)?(?:RECURSIVE\s+)?VIEW|CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|RULE|(?:CONSTRAINT\s+)?TRIGGER)|(?:CREATE|ALTER)\s+POLICY|COMMENT)\b/i;
// Statements that change which schemas qualified names reach.
const SCHEMA_CHANGE = /^\s*(?:ALTER|DROP)\s+SCHEMA\b/i;
// Relations created, renamed, moved to another schema or dropped: a table's
// name may then reach another relation, or none.
const CREATED_RELATION = new RegExp(
  String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED|FOREIGN)\s+)?(?:RECURSIVE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE_NAME}`,
  "i",
);
const SELECTED_INTO = new RegExp(
  String.raw`^\s*SELECT\b[\s\S]*?\bINTO\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?(?:TABLE\s+)?${TABLE_NAME}`,
  "i",
);
const MOVED_RELATION = new RegExp(
  String.raw`^\s*ALTER\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FOREIGN\s+TABLE|SEQUENCE|INDEX)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE_NAME}\s*\*?\s*(?:RENAME\s+TO\s+(${IDENTIFIER})|SET\s+SCHEMA\s+${IDENTIFIER})\s*$`,
  "i",
);
const DROPPED_RELATIONS =
  /^\s*DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FOREIGN\s+TABLE|SEQUENCE)\s+(?:IF\s+EXISTS\s+)?([\s\S]*?)\s*(?:CASCADE|RESTRICT)?\s*$/i;

/**
 * Whether a statement changes where unqualified names resolve: a SET or
 * RESET of search_path or the role, a set_config() call whose name is
 * 'search_path', 'role' or 'session_authorization', or is not a plain
 * literal, a DO block, CALL or EXECUTE, which may do either, or a schema
 * renamed or dropped. Only its code counts, not its comments, strings,
 * quoted names or function bodies, nor a view's query.
 */
const setsSearchPath = ({
  code,
  literals,
}: {
  readonly code: string;
  readonly literals: readonly string[];
}): boolean => {
  if (SETS_PATH.test(code) || OPAQUE.test(code) || SCHEMA_CHANGE.test(code)) {
    return true;
  }

  if (STORES_CODE.test(code)) {
    return false;
  }

  // Each literal is one '' of the code, once quoted names are blanked.
  const text = code.replace(/"(?:[^"]|"")*"/g, (name) =>
    name === '"set_config"' ? "set_config" : '""',
  );

  for (const call of text.matchAll(SET_CONFIG)) {
    if (call[2] === undefined) {
      return true;
    }

    const before = text.slice(0, call.index + call[0].length - 2);
    const literal = literals[(before.match(/''/g) ?? []).length];

    if (literal === undefined) {
      return true;
    }

    const tag = /^\$[^$]*\$/.exec(literal)?.[0];
    const value = tag
      ? literal.slice(tag.length, -tag.length)
      : literal.slice(1, -1).replaceAll("''", "'");

    if (
      PATH_SETTINGS.has(value.toLowerCase()) ||
      (call[1] !== undefined && value.includes("\\"))
    ) {
      return true;
    }
  }

  return false;
};

const KEY_USING_INDEX = new RegExp(
  String.raw`^ADD\s+(?:CONSTRAINT\s+${IDENTIFIER}\s+)?UNIQUE\s+USING\s+INDEX\s+${IDENTIFIER}(?:\s+(?:NOT\s+)?DEFERRABLE)?(?:\s+INITIALLY\s+(?:DEFERRED|IMMEDIATE))?\s*$`,
  "i",
);

/** An identifier the way PostgreSQL folds it: quoted names verbatim, others lower-cased. */
const identifierKey = (name: string): string =>
  name.startsWith('"')
    ? name.slice(1, -1).replaceAll('""', '"')
    : name.toLowerCase();

// Every identifier of a name (match() starts a global search from the start).
const IDENTIFIERS = new RegExp(IDENTIFIER, "g");

/** Normalizes a possibly qualified, possibly quoted table name the way PostgreSQL folds it. */
const tableKey = (name: string): string =>
  (name.match(IDENTIFIERS) ?? []).map(identifierKey).join(".");

/** The unqualified object name, for matching drops with re-creations. */
const objectKey = (name: string): string =>
  identifierKey(name.match(IDENTIFIERS)!.at(-1)!);

/** The schema of a possibly qualified name the way PostgreSQL folds it, if it names one. */
const schemaKey = (name: string): string | undefined => {
  const parts = name.match(IDENTIFIERS) ?? [];

  return parts.length > 1 ? identifierKey(parts.at(-2)!) : undefined;
};

/**
 * Values kept by relation name and by the schema the name was written with:
 * a schema, or none, which means the schema search_path gives it (`path`:
 * how many statements before changed search_path). A name written with a
 * schema surely means what is kept under that schema and surely not what is
 * kept under another; written without one, it surely means what is kept
 * without one under the same search_path. Any other pairing may or may not
 * be the same object.
 */
const bySchema = <T>() => {
  const names = new Map<
    string,
    { named: Map<string, T>; unqualified: Map<number, T> }
  >();
  /** What the name surely means. */
  const get = (
    name: string,
    schema: string | undefined,
    path: number,
  ): T | undefined =>
    schema === undefined
      ? names.get(name)?.unqualified.get(path)
      : names.get(name)?.named.get(schema);
  const set = (
    name: string,
    schema: string | undefined,
    path: number,
    value: T,
  ): void => {
    let kept = names.get(name);

    if (kept === undefined) {
      kept = { named: new Map(), unqualified: new Map() };
      names.set(name, kept);
    }

    if (schema === undefined) {
      kept.unqualified.set(path, value);
    } else {
      kept.named.set(schema, value);
    }
  };
  /** Removes what the name surely means, and returns it. */
  const take = (
    name: string,
    schema: string | undefined,
    path: number,
  ): T | undefined => {
    const value = get(name, schema, path);

    if (schema === undefined) {
      names.get(name)?.unqualified.delete(path);
    } else {
      names.get(name)?.named.delete(schema);
    }

    return value;
  };
  /** Removes what the name may or may not mean, and returns it. */
  const takeUncertain = (
    name: string,
    schema: string | undefined,
    path: number,
  ): T[] => {
    const kept = names.get(name);
    const taken: T[] = [];

    for (const [key, value] of kept?.unqualified ?? []) {
      if (schema !== undefined || key !== path) {
        taken.push(value);
        kept!.unqualified.delete(key);
      }
    }

    if (schema === undefined) {
      for (const value of kept?.named.values() ?? []) {
        taken.push(value);
      }

      kept?.named.clear();
    }

    return taken;
  };

  return {
    get,
    set,
    take,
    takeUncertain,
    /** Removes what the name surely or may mean, and returns it. */
    takeMaybe: (
      name: string,
      schema: string | undefined,
      path: number,
    ): T[] => {
      const value = take(name, schema, path);
      const taken = takeUncertain(name, schema, path);

      return value === undefined ? taken : [value, ...taken];
    },
    /** Removes everything kept under the name, and returns it. */
    takeAll: (name: string): T[] => {
      const kept = names.get(name);

      names.delete(name);

      return kept === undefined
        ? []
        : [...kept.named.values(), ...kept.unqualified.values()];
    },
    clear: (): void => {
      names.clear();
    },
  };
};

/**
 * A set of names made of dot-separated parts (`table.column`,
 * `schema.table`) that also finds, and drops, every name with a given part
 * before one of its dots (`name.startsWith(`${part}.`)`) or, with `after`,
 * after one of them or as the whole name (`name.endsWith(`.${part}`)`),
 * without reading the others.
 */
const dottedNames = (after = false) => {
  const names = new Set<string>();
  // The names found under each part (some of them dropped since).
  const byPart = new Map<string, Set<string>>();

  return {
    has: (name: string): boolean => names.has(name),
    add: (name: string): void => {
      if (names.has(name)) {
        return;
      }

      names.add(name);

      const parts = after ? [name] : [];

      for (
        let dot = name.indexOf(".");
        dot !== -1;
        dot = name.indexOf(".", dot + 1)
      ) {
        parts.push(after ? name.slice(dot + 1) : name.slice(0, dot));
      }

      for (const part of parts) {
        const found = byPart.get(part);

        if (found === undefined) {
          byPart.set(part, new Set([name]));
        } else {
          found.add(name);
        }
      }
    },
    delete: (name: string): void => {
      names.delete(name);
    },
    /** Whether a name with this part is kept. */
    hasPart: (part: string): boolean => {
      const found = byPart.get(part);

      for (const name of found ?? []) {
        if (names.has(name)) {
          return true;
        }

        found!.delete(name);
      }

      return false;
    },
    /** Drops every name with this part. */
    deletePart: (part: string): void => {
      for (const name of byPart.get(part) ?? []) {
        names.delete(name);
      }

      byPart.delete(part);
    },
    clear: (): void => {
      names.clear();
      byPart.clear();
    },
  };
};

type NotNullCheck = {
  name: string;
  column: { readonly checks: Set<NotNullCheck> };
  valid: boolean;
  /** The statement that added it. */
  readonly since: number;
  /** Whether its table is named with its schema. */
  readonly qualified: boolean;
};
type CheckedTable = {
  key: string;
  /** The table's name without its schema. */
  object: string;
  readonly checks: Map<string, NotNullCheck>;
  readonly columns: Map<string, NotNullCheck["column"]>;
};

/**
 * The CHECK (column IS NOT NULL) constraints added in a migration, by table
 * (its key, as tableKey() spells it), name and column: whether they are valid
 * yet, where they were added and whether their table is named with its
 * schema. A table's RENAME TO takes them along, a RENAME COLUMN its column's.
 */
const notNullChecks = () => {
  const tables = new Map<string, CheckedTable>();
  const byObject = new Map<string, Set<CheckedTable>>();
  const place = (table: CheckedTable): void => {
    tables.set(table.key, table);

    const found = byObject.get(table.object);

    if (found === undefined) {
      byObject.set(table.object, new Set([table]));
    } else {
      found.add(table);
    }
  };
  const remove = (table: CheckedTable, name: string): void => {
    const check = table.checks.get(name);

    table.checks.delete(name);
    check?.column.checks.delete(check);
  };
  const add = (
    key: string,
    object: string,
    check: Omit<NotNullCheck, "column">,
    column: string,
  ): void => {
    let table = tables.get(key);

    if (table === undefined) {
      table = { key, object, checks: new Map(), columns: new Map() };
      place(table);
    }

    remove(table, check.name);

    let checks = table.columns.get(column);

    if (checks === undefined) {
      checks = { checks: new Set() };
      table.columns.set(column, checks);
    }

    const added = { ...check, column: checks };

    checks.checks.add(added);
    table.checks.set(check.name, added);
  };

  return {
    add,
    get: (key: string, name: string): NotNullCheck | undefined =>
      tables.get(key)?.checks.get(name),
    delete: (key: string, name: string): void => {
      const table = tables.get(key);

      if (table !== undefined) {
        remove(table, name);
      }
    },
    /** The checks of a column. */
    of: (key: string, column: string): Iterable<NotNullCheck> =>
      tables.get(key)?.columns.get(column)?.checks ?? [],
    renameConstraint: (key: string, from: string, to: string): void => {
      const table = tables.get(key);
      const check = table?.checks.get(from);

      if (table === undefined) {
        return;
      }

      remove(table, from);
      remove(table, to);

      if (check !== undefined) {
        check.name = to;
        check.column.checks.add(check);
        table.checks.set(to, check);
      }
    },
    renameColumn: (key: string, from: string, to: string): void => {
      const table = tables.get(key);
      const moving = table?.columns.get(from);

      if (table === undefined || moving === undefined || from === to) {
        return;
      }

      const there = table.columns.get(to);

      table.columns.delete(from);

      if (there === undefined) {
        table.columns.set(to, moving);
        return;
      }

      // The column's checks join those of the column now so named.
      const [larger, smaller] =
        there.checks.size < moving.checks.size
          ? [moving, there]
          : [there, moving];

      for (const check of smaller.checks) {
        check.column = larger;
        larger.checks.add(check);
      }

      table.columns.set(to, larger);
    },
    dropColumn: (key: string, column: string): void => {
      const table = tables.get(key);

      for (const check of table?.columns.get(column)?.checks ?? []) {
        table!.checks.delete(check.name);
      }

      table?.columns.delete(column);
    },
    /**
     * Relations of these names (without schema) created, renamed, moved or
     * dropped: tables of those names keep no checks, except the one a RENAME
     * TO renames, which keeps them under its new name.
     */
    touch: (
      objects: ReadonlySet<string>,
      renamed?: { from: string; to: string; object: string },
    ): void => {
      let moving: CheckedTable | undefined;
      const there = renamed === undefined ? undefined : tables.get(renamed.to);

      for (const object of objects) {
        for (const table of byObject.get(object) ?? []) {
          tables.delete(table.key);

          if (table.key === renamed?.from) {
            moving = table;
          }
        }

        byObject.delete(object);
      }

      if (moving !== undefined) {
        if (there !== undefined && there !== moving) {
          // Renamed onto a table that still has checks (which PostgreSQL
          // refuses): a check of a name both have proves nothing.
          tables.delete(there.key);
          byObject.get(there.object)?.delete(there);

          const [few, many] =
            there.checks.size < moving.checks.size
              ? [there, moving]
              : [moving, there];

          for (const name of [...few.checks.keys()]) {
            if (many.checks.has(name)) {
              remove(moving, name);
            }
          }
        }

        moving.key = renamed!.to;
        moving.object = renamed!.object;
        place(moving);
      }
    },
    clear: (): void => {
      tables.clear();
      byObject.clear();
    },
  };
};

/** Keywords and unquoted identifiers of code whose literals are already blanked. */
const wordsOf = (code: string): string[] =>
  (
    code.replace(/"(?:[^"]|"")*"/g, " ").match(/[A-Za-z_][A-Za-z_0-9$]*/g) ?? []
  ).map((word) => word.toUpperCase());

/** The comma-separated actions of an ALTER TABLE, ignoring commas inside parentheses. */
const splitActions = (code: string): string[] => {
  const actions: string[] = [];
  let depth = 0;
  let start = 0;
  let quoted = false;

  for (let position = 0; position < code.length; position++) {
    const character = code[position];

    if (character === '"') {
      quoted = !quoted;
    } else if (quoted) {
      continue;
    } else if (character === "(") {
      depth++;
    } else if (character === ")") {
      depth = Math.max(0, depth - 1);
    } else if (character === "," && !depth) {
      actions.push(code.slice(start, position).trim());
      start = position + 1;
    }
  }

  actions.push(code.slice(start).trim());

  return actions.filter(Boolean);
};

const levelOrder = { destructive: 0, blocking: 1, caution: 2 } as const;

/**
 * Reviews the SQL that will execute. Comments, strings and function bodies
 * never classify a statement, except the `-- symmetria: caution:` and
 * `-- symmetria: destructive:` notes generate writes on their own line, which
 * rate it as generate did (see CAUTION_NOTE and DESTRUCTIVE_NOTE).
 */
export const lintMigrationSQL = (sql: string, name = "SQL"): SQLFinding[] => {
  const statements = parseMigrationSQL(sql);
  // Tables created earlier in the same migration are new and empty, so locks and
  // existing-row preconditions on them cannot block anything.
  const created = dottedNames(true);
  // Columns added earlier without a default hold only NULL, which every foreign key accepts.
  const nullColumns = dottedNames();
  // Columns added earlier whose rows each got their own value (an identity, a
  // volatile default): a unique key over one of them cannot fail.
  const distinctColumns = dottedNames();
  // Columns retyped earlier: re-adding their keys and checks rebuilds what held before.
  const retyped = dottedNames();
  // Constraints and indexes dropped earlier in this migration.
  const dropped = new Set<string>();
  // Constraints dropped earlier, by table (following renames of the table).
  const droppedOn = new Map<string, Set<string>>();
  // Statements with a caution note on a shape generate writes it on.
  const cautioned = new Map<number, string>();
  // The indexes, and the constraints by table, each statement creates. An
  // index lives in the schema of its table.
  const creations = statements.map(({ code }) => {
    const index = code.match(CREATED_INDEX)?.[1];
    const target =
      index === undefined ? undefined : code.match(TARGET_TABLE)?.[1];
    const table = code.match(ALTER_TABLE);

    return {
      indexes: index
        ? [
            {
              name: objectKey(index),
              table: target === undefined ? undefined : objectKey(target),
              schema: target === undefined ? undefined : schemaKey(target),
              proof: !IF_NOT_EXISTS_INDEX.test(code),
            },
          ]
        : [],
      constraints: table
        ? splitActions(table[2]!).flatMap((action) => {
            const constraint = action.match(NAMED_CONSTRAINT)?.[1];

            return constraint
              ? [
                  {
                    table: objectKey(table[1]!),
                    schema: schemaKey(table[1]!),
                    name: objectKey(constraint),
                  },
                ]
              : [];
          })
        : [],
    };
  });
  // The indexes and constraints each statement drops: the names of all of
  // them (a DROP INDEX of a list included), the one index of a DROP INDEX
  // that names one, and the table and constraints of an ALTER TABLE.
  const drops = statements.map(({ code }) => {
    const indexes = code.match(DROPPED_INDEXES)?.[1];
    const table = code.match(ALTER_TABLE);
    const constraints = table
      ? splitActions(table[2]!).flatMap((action) => {
          const constraint = action.match(DROPPED_CONSTRAINT)?.[1];

          return constraint === undefined ? [] : [constraint];
        })
      : [];

    return {
      names: [
        ...(indexes
          ? splitActions(indexes).flatMap((name) =>
              OBJECT_NAME.test(name) ? [objectKey(name)] : [],
            )
          : []),
        ...constraints.map(objectKey),
      ],
      index: code.match(DROPPED_INDEX)?.[1],
      table: table?.[1],
      constraints,
    };
  });
  // Unqualified names resolve through search_path: once a statement changes
  // it, two of them on either side of it may name objects in different
  // schemas. pathsBefore[position] counts the statements before `position`
  // that change it, so an unqualified name written at `position` means the
  // same schema as one written at `from` (before it) when
  // pathsBefore[from + 1] equals pathsBefore[position].
  const pathsBefore = [0];

  statements.forEach((statement, position) => {
    pathsBefore.push(
      pathsBefore[position]! + (setsSearchPath(statement) ? 1 : 0),
    );
  });
  // What each statement does to relation names: those it creates, renames,
  // moves to another schema or drops (indexes and constraints included), the
  // rename of one, and whether it runs code that may do any of it.
  const relationChanges = statements.map(({ code }, position) => {
    const moved = code.match(MOVED_RELATION);
    const droppedRelations = code.match(DROPPED_RELATIONS)?.[1];
    const names = [
      code.match(CREATED_RELATION)?.[1],
      code.match(SELECTED_INTO)?.[1],
      moved?.[1],
      moved?.[2],
      ...(droppedRelations === undefined
        ? []
        : splitActions(droppedRelations).filter((name) =>
            OBJECT_NAME.test(name),
          )),
    ].flatMap((name) => (name === undefined ? [] : [name]));

    return {
      names,
      moved,
      dropped: droppedRelations !== undefined,
      opaque: OPAQUE.test(code) || SCHEMA_CHANGE.test(code),
      touched: new Set([...names.map(objectKey), ...drops[position]!.names]),
    };
  });
  const pathChangedBetween = (from: number, to: number): boolean =>
    to - from > 1 && pathsBefore[to]! > pathsBefore[from + 1]!;
  // The table each ALTER TABLE … RENAME TO renames (its schema and name), and
  // its new name.
  const tableRenames = statements.map(({ code }) => {
    const table = code.match(ALTER_TABLE);
    const actions = table ? splitActions(table[2]!) : [];
    const to =
      actions.length === 1 ? actions[0]!.match(RENAMED_TABLE)?.[1] : undefined;

    return to === undefined
      ? undefined
      : {
          schema: schemaKey(table![1]!),
          from: objectKey(table![1]!),
          to: objectKey(to),
        };
  });
  // Where each name is first dropped.
  const firstRemoval = new Map<string, number>();

  drops.forEach(({ names }, at) => {
    for (const name of names) {
      if (!firstRemoval.has(name)) {
        firstRemoval.set(name, at);
      }
    }
  });

  // The names of the indexes and constraints each statement drops that an
  // earlier statement surely created (harmless), and of those a later
  // statement creates again (rebuilt). One pass over the file finds each.
  const harmless = new Map<number, Set<string>>();
  const rebuilt = new Map<number, Set<string>>();
  const mark = (
    marks: Map<number, Set<string>>,
    position: number,
    name: string,
  ): void => {
    const names = marks.get(position);

    if (names === undefined) {
      marks.set(position, new Set([name]));
    } else {
      names.add(name);
    }
  };

  {
    /**
     * Lint follows each index the migration surely created, and each table
     * it created a constraint or an index on, by name and schema from the
     * statement after the creation on. A rename (any ALTER … RENAME TO)
     * takes what is followed under the name in its schema to the new name.
     * Everything under a name is lost once the name may reach another
     * object: a rename of it, or into it, in a schema that may be its own,
     * a relation of that name created, dropped or moved to another schema,
     * an index or constraint of that name dropped, or code lint cannot
     * read. A table moved to another schema takes its indexes along: they
     * are lost too, as are those whose table lint no longer follows.
     */
    type Index = { readonly at: number; lost: boolean };
    type Followed = {
      /** The indexes under this name, oldest first; `live`: the first not lost. */
      readonly indexes: Index[];
      live: number;
      /** The constraints created on the table of this name. */
      readonly constraints: Set<string>;
      /** The indexes created on the table of this name. */
      readonly onTable: Index[];
    };
    const followed = bySchema<Followed>();
    // Indexes whose table lint no longer follows: any table moved to
    // another schema may be theirs.
    let unplaced: Index[][] = [];
    const followedAt = (
      name: string,
      schema: string | undefined,
      path: number,
    ): Followed => {
      const found = followed.get(name, schema, path);

      if (found !== undefined) {
        return found;
      }

      const added = {
        indexes: [],
        live: 0,
        constraints: new Set<string>(),
        onTable: [],
      };

      followed.set(name, schema, path, added);

      return added;
    };
    const unfollow = (lost: readonly Followed[]): void => {
      for (const { onTable } of lost) {
        unplaced.push(onTable);
      }
    };
    const lose = (lists: readonly (readonly Index[])[]): void => {
      for (const list of lists) {
        for (const index of list) {
          index.lost = true;
        }
      }
    };

    statements.forEach((_, position) => {
      const path = pathsBefore[position]!;
      const { index, table, constraints } = drops[position]!;

      // The drops, against what the statements before this one created:
      // not a creation after the first drop of the dropped name.
      if (index !== undefined) {
        const name = objectKey(index);
        const found = followed.get(name, schemaKey(index), path);

        if (found !== undefined) {
          while (found.indexes[found.live]?.lost) {
            found.live++;
          }

          const oldest = found.indexes[found.live];

          if (
            oldest !== undefined &&
            !((firstRemoval.get(name) ?? Number.POSITIVE_INFINITY) < oldest.at)
          ) {
            mark(harmless, position, name);
          }
        }
      }

      if (table !== undefined && constraints.length > 0) {
        const found = followed.get(objectKey(table), schemaKey(table), path);

        for (const constraint of constraints) {
          if (found?.constraints.has(objectKey(constraint))) {
            mark(harmless, position, objectKey(constraint));
          }
        }
      }

      // What the statement does to the names of relations.
      const change = relationChanges[position]!;

      if (change.opaque) {
        followed.clear();
        unplaced = [];
      } else if (change.moved?.[2] !== undefined) {
        const schema = schemaKey(change.moved[1]!);
        const from = objectKey(change.moved[1]!);
        const into = objectKey(change.moved[2]);

        if (from !== into) {
          const renamed = followed.take(from, schema, path);

          unfollow(followed.takeUncertain(from, schema, path));
          unfollow(followed.takeMaybe(into, schema, path));

          if (renamed !== undefined) {
            followed.set(into, schema, path, renamed);
          }
        }
      } else {
        if (change.moved) {
          lose(unplaced);
          unplaced = [];
          lose(
            followed
              .takeMaybe(
                objectKey(change.moved[1]!),
                schemaKey(change.moved[1]!),
                path,
              )
              .map(({ onTable }) => onTable),
          );
        }

        for (const name of change.touched) {
          unfollow(followed.takeAll(name));
        }
      }

      // What it creates: an index only without IF NOT EXISTS, a constraint
      // only before the first drop of its name.
      const after = pathsBefore[position + 1]!;

      for (const created of creations[position]!.indexes) {
        if (created.proof) {
          const index = { at: position, lost: false };

          followedAt(created.name, created.schema, after).indexes.push(index);

          if (created.table === undefined) {
            unplaced.push([index]);
          } else {
            followedAt(created.table, created.schema, after).onTable.push(
              index,
            );
          }
        }
      }

      for (const created of creations[position]!.constraints) {
        if (
          !(
            (firstRemoval.get(created.name) ?? Number.POSITIVE_INFINITY) <
            position
          )
        ) {
          followedAt(created.table, created.schema, after).constraints.add(
            created.name,
          );
        }
      }
    });
  }

  {
    /**
     * Drops wait for a later creation of their name. An index's needs the
     * same schema; a constraint's, its table, which lint follows by name and
     * schema through ALTER TABLE … RENAME TO (lost when the rename may or
     * may not be of it) and loses when it may move to another schema.
     */
    type Waiting = { readonly names: Map<string, number[]>; size: number };
    const indexDrops = bySchema<number[]>();
    const constraintDrops = bySchema<Waiting>();
    const rebuild = (positions: readonly number[], name: string): void => {
      for (const at of positions) {
        mark(rebuilt, at, name);
      }
    };

    statements.forEach((_, position) => {
      const path = pathsBefore[position]!;
      const { indexes, constraints } = creations[position]!;

      for (const created of [...indexes, ...constraints]) {
        const dropped = indexDrops.take(created.name, created.schema, path);

        if (dropped !== undefined) {
          rebuild(dropped, created.name);
        }

        const waiting =
          created.table === undefined
            ? undefined
            : constraintDrops.get(created.table, created.schema, path);
        const onTable = waiting?.names.get(created.name);

        if (onTable !== undefined) {
          rebuild(onTable, created.name);
          waiting!.names.delete(created.name);
          waiting!.size -= onTable.length;
        }
      }

      const after = pathsBefore[position + 1]!;
      const { index, table, constraints: dropped } = drops[position]!;

      if (index !== undefined) {
        const name = objectKey(index);
        const schema = schemaKey(index);
        const waiting = indexDrops.get(name, schema, after);

        if (waiting === undefined) {
          indexDrops.set(name, schema, after, [position]);
        } else {
          waiting.push(position);
        }
      }

      const again = new Set(constraints.map((created) => created.name));

      for (const constraint of dropped) {
        const name = objectKey(constraint);

        // Created again in the same statement, so on the same table.
        if (again.has(name)) {
          mark(rebuilt, position, name);
          continue;
        }

        const [object, schema] = [objectKey(table!), schemaKey(table!)];
        let waiting = constraintDrops.get(object, schema, after);

        if (waiting === undefined) {
          waiting = { names: new Map(), size: 0 };
          constraintDrops.set(object, schema, after, waiting);
        }

        const positions = waiting.names.get(name);

        if (positions === undefined) {
          waiting.names.set(name, [position]);
        } else {
          positions.push(position);
        }

        waiting.size++;
      }

      const renamed = tableRenames[position];

      if (renamed !== undefined && renamed.from !== renamed.to) {
        const moving = constraintDrops.take(renamed.from, renamed.schema, path);

        constraintDrops.takeUncertain(renamed.from, renamed.schema, path);

        const there = constraintDrops.get(renamed.to, renamed.schema, path);

        if (moving !== undefined && there === undefined) {
          constraintDrops.set(renamed.to, renamed.schema, path, moving);
        } else if (moving !== undefined && there !== undefined) {
          // Both wait on the renamed table now: the smaller joins the larger.
          const [larger, smaller] =
            there.size < moving.size ? [moving, there] : [there, moving];

          for (const [name, positions] of smaller.names) {
            const joined = larger.names.get(name);

            if (joined === undefined) {
              larger.names.set(name, positions);
            } else {
              for (const at of positions) {
                joined.push(at);
              }
            }
          }

          larger.size += smaller.size;
          constraintDrops.set(renamed.to, renamed.schema, path, larger);
        }
      }

      const moved = relationChanges[position]!.moved;

      if (moved && moved[2] === undefined) {
        constraintDrops.takeMaybe(
          objectKey(moved[1]!),
          schemaKey(moved[1]!),
          path,
        );
      }
    });
  }

  /**
   * An index, or a constraint of the table, that a statement before
   * `position` created: dropping it removes nothing that was there before the
   * migration, as when --online drops the CHECK that set NOT NULL. Only a
   * creation that would fail on an existing object proves it new: not CREATE
   * INDEX IF NOT EXISTS, nor one after a drop of that name, nor one in a
   * schema that may be another, nor one lint lost track of (see above).
   */
  const createdBefore = (position: number, dropped: string): boolean =>
    harmless.get(position)?.has(objectKey(dropped)) ?? false;
  /**
   * Whether this statement or a later one creates the dropped index, or the
   * dropped constraint of the table (under the table's later names), again
   * in the same schema: dropping it first rebuilds it rather than removing it.
   */
  const createdAgain = (position: number, dropped: string): boolean =>
    rebuilt.get(position)?.has(objectKey(dropped)) ?? false;
  // CHECK (column IS NOT NULL) constraints added in this migration.
  const checks = notNullChecks();

  const findings = statements.flatMap(
    ({ words, code, lineComments }, position): SQLFinding[] => {
      const text = words.join(" ");
      const createdTable = code.match(CREATED_TABLE)?.[1];

      if (createdTable) {
        created.add(tableKey(createdTable));
      }

      const target = code.match(TARGET_TABLE)?.[1];
      const table = target === undefined ? undefined : tableKey(target);
      const newTable = table !== undefined && created.has(table);
      const column = (name: string) => `${table}.${identifierKey(name)}`;

      /**
       * Forgets what lint knows of the columns added earlier (of one table, or
       * of all): a statement may have written them, as the backfill between
       * ADD COLUMN and a key does.
       */
      const forget = (prefix?: string): void => {
        for (const known of [nullColumns, distinctColumns]) {
          if (prefix === undefined) {
            known.clear();
          } else {
            known.deletePart(prefix);
          }
        }
      };

      if (!ALTER_TABLE.test(code) && !KEEPS_VALUES.test(text)) {
        forget();
      }

      // A relation created, renamed, moved or dropped: a name a NOT NULL
      // proof was made under may now reach another table, or none, so the
      // proofs of tables of that name go. A table's own RENAME TO takes its
      // proofs along under the new name. A DO block, CALL or EXECUTE, or a
      // schema renamed or dropped, may have done any of it.
      const {
        names: relations,
        moved,
        dropped: dropsRelations,
        opaque,
      } = relationChanges[position]!;

      if (opaque) {
        checks.clear();
      } else if (relations.length) {
        const objects = new Set(relations.map(objectKey));
        const renamed =
          moved?.[2] !== undefined && /^\s*ALTER\s+TABLE\b/i.test(code)
            ? {
                from: tableKey(moved[1]!),
                // RENAME TO keeps the schema, as tableKey() spells it.
                to: [schemaKey(moved[1]!), objectKey(moved[2])]
                  .filter((part) => part !== undefined)
                  .join("."),
                object: objectKey(moved[2]),
              }
            : undefined;

        checks.touch(objects, renamed);

        // A table created in this migration, renamed or dropped: its name
        // no longer stands for a new, empty table, nor its added columns
        // for columns that hold only NULL or their own values.
        if (moved || dropsRelations) {
          const wasCreated = renamed !== undefined && created.has(renamed.from);

          for (const name of relations) {
            forget(tableKey(name));
            created.deletePart(objectKey(name));
          }

          if (wasCreated) {
            created.add(renamed!.to);
          }
        }
      }

      const finding = (
        level: SQLFinding["level"],
        message: string,
        advice: string,
      ): SQLFinding => ({
        level,
        table: name,
        statement: position + 1,
        message: `Statement ${position + 1}: ${message}`,
        advice,
      });

      const rebuild = finding(
        "caution",
        "Rebuilds a constraint or index that this migration creates again.",
        "The rebuild scans the table under a lock; on large tables prefer a rename or a concurrent build.",
      );
      const destructive = finding(
        "destructive",
        "Removes data or a database object.",
        "Review the exact SQL and deploy dependent application changes first.",
      );
      const review = finding(
        "caution",
        "Contains a schema change, data operation or executable SQL requiring review.",
        "Verify locks, data preconditions and the upgrade against representative data. SQL lint does not analyze function bodies.",
      );
      const unique = finding(
        "blocking",
        "Requires unique existing values.",
        "Check and resolve duplicates before applying.",
      );

      /**
       * A unique key over columns added in this migration whose existing rows
       * each got their own value, or (a UNIQUE key, which accepts NULLs) hold
       * only NULL: it cannot fail.
       */
      const freshKey = (
        keys: readonly string[] | undefined,
        primary: boolean,
      ): boolean =>
        !!keys?.length &&
        (primary
          ? keys.some((key) => distinctColumns.has(column(key))) &&
            !keys.some((key) => nullColumns.has(column(key)))
          : keys.some((key) => distinctColumns.has(column(key))) ||
            keys.every((key) => nullColumns.has(column(key))));
      const fresh = /^CREATE UNIQUE INDEX CONCURRENTLY\b/.test(text)
        ? finding(
            "caution",
            "Builds a unique index CONCURRENTLY on columns added in this migration, whose existing rows hold distinct values or NULL; reads and writes go on while it builds.",
            "If the build fails, it leaves an invalid index: drop it before running the migration again.",
          )
        : finding(
            "caution",
            "Builds a unique index on columns added in this migration, whose existing rows hold distinct values or NULL; it blocks writes while it builds.",
            "On a large table run the migration in a quiet hour.",
          );

      /** A key or check dropped earlier and added again after its columns changed type. */
      const rebuiltAfterRetype = (
        constraint: string | undefined,
        keys: string[] | undefined,
      ): boolean =>
        constraint !== undefined &&
        dropped.has(objectKey(constraint)) &&
        (keys
          ? keys.length > 0 && keys.every((key) => retyped.has(column(key)))
          : retyped.hasPart(`${table}`));

      const alteration = code.match(ALTER_TABLE);
      const actions = alteration ? splitActions(alteration[2]!) : [];
      const note = noteText(lineComments, CAUTION_LINE);

      if (note !== undefined) {
        const only = actions.length === 1 ? actions[0]! : undefined;
        const key = only?.match(NOTED_KEY)?.[1];
        const droppedConstraint = only?.match(DROPPED_CONSTRAINT)?.[1];
        // The key's columns may have been renamed since, and with them its
        // name: a constraint dropped earlier on the table is what counts.
        const keyDropped =
          key !== undefined && (droppedOn.get(table!)?.size ?? 0) > 0;

        if (
          alteration
            ? keyDropped ||
              (droppedConstraint !== undefined && !/\bCASCADE\b/i.test(only!))
            : NOTED_DROP.test(code)
        ) {
          cautioned.set(position + 1, note);
        }
      }

      // A renamed table keeps what was dropped on it.
      const renamedTo =
        actions.length === 1
          ? actions[0]!.match(RENAMED_TABLE)?.[1]
          : undefined;

      if (renamedTo !== undefined && droppedOn.has(table!)) {
        droppedOn.set(tableKey(renamedTo), droppedOn.get(table!)!);
        droppedOn.delete(table!);
      }

      const renamedColumn =
        actions.length === 1 ? actions[0]!.match(RENAMED_COLUMN) : undefined;

      if (renamedColumn) {
        checks.renameColumn(
          `${table}`,
          identifierKey(renamedColumn[1]!),
          identifierKey(renamedColumn[2]!),
        );
      }

      const renamedConstraint =
        actions.length === 1
          ? actions[0]!.match(RENAMED_CONSTRAINT)
          : undefined;

      if (renamedConstraint) {
        checks.renameConstraint(
          `${table}`,
          objectKey(renamedConstraint[1]!),
          objectKey(renamedConstraint[2]!),
        );
      }

      // Renames change the catalog only, under a brief ACCESS EXCLUSIVE lock. The
      // action itself has to be RENAME: a table or column may be called `rename`.
      if (
        RENAMED_OBJECT.test(code) ||
        (actions.length > 0 && actions.every((action) => RENAME.test(action)))
      ) {
        return [];
      }

      if (alteration) {
        const findings = actions.flatMap((action): SQLFinding[] => {
          const actionWords = wordsOf(action);
          const actionText = actionWords.join(" ");
          const changed = action.match(ALTERED_COLUMN);

          // A type change (its USING) or another expression may write the column.
          if (changed) {
            if (!KEEPS_COLUMN_VALUES.test(wordsOf(changed[2]!).join(" "))) {
              nullColumns.delete(column(changed[1]!));
              distinctColumns.delete(column(changed[1]!));
            }
          } else if (!KEEPS_TABLE_VALUES.test(actionText)) {
            forget(table);
          }

          const check = action.match(NOT_NULL_CHECK);

          if (check) {
            checks.add(
              `${table}`,
              objectKey(alteration[1]!),
              {
                name: objectKey(check[1]!),
                valid: check[3] === undefined,
                since: position,
                qualified: schemaKey(alteration[1]!) !== undefined,
              },
              identifierKey(check[2]!),
            );
          }

          const validated = action.match(VALIDATED_CONSTRAINT)?.[1];

          if (validated !== undefined) {
            const entry = checks.get(`${table}`, objectKey(validated));

            if (entry) {
              entry.valid = true;
            }
          }

          const droppedConstraint = action.match(DROPPED_CONSTRAINT)?.[1];

          if (
            droppedConstraint !== undefined &&
            createdBefore(position, droppedConstraint)
          ) {
            checks.delete(`${table}`, objectKey(droppedConstraint));

            return [];
          }

          if (droppedConstraint !== undefined) {
            checks.delete(`${table}`, objectKey(droppedConstraint));
            dropped.add(objectKey(droppedConstraint));
            droppedOn.set(
              table!,
              (droppedOn.get(table!) ?? new Set()).add(
                objectKey(droppedConstraint),
              ),
            );

            return createdAgain(position, droppedConstraint)
              ? [rebuild]
              : [destructive];
          }

          const droppedColumn = action.match(DROPPED_COLUMN)?.[1];

          if (droppedColumn !== undefined) {
            checks.dropColumn(`${table}`, identifierKey(droppedColumn));
          }

          if (/\bDROP(?:$| (?!DEFAULT\b|NOT\b|IDENTITY\b))/.test(actionText)) {
            return [destructive];
          }

          const altered = action.match(ALTERED_COLUMN);
          const alteredText = altered ? wordsOf(altered[2]!).join(" ") : "";
          const retypes = /^(?:SET DATA )?TYPE\b/.test(alteredText);

          if (retypes) {
            retyped.add(column(altered![1]!));
          }

          if (retypes && TRUNCATING_CAST.test(altered![2]!)) {
            return [
              finding(
                "destructive",
                "USING casts explicitly to a length-limited string type, which cuts longer values instead of failing.",
                "Leave USING out (or cast to text) so PostgreSQL refuses values that do not fit, unless the column only gets longer.",
              ),
            ];
          }

          if (retypes && !newTable && EMPTYING_CAST.test(altered![2]!)) {
            return [
              finding(
                "destructive",
                "USING gives every row the same value (NULL or a constant): every existing value is lost.",
                "Convert the values in USING, or copy the column first if its values are no longer needed.",
              ),
            ];
          }

          if (newTable) {
            return [];
          }

          if (/^SET NOT NULL\b/.test(alteredText)) {
            // A valid CHECK that the column is not NULL proves it: PostgreSQL
            // skips the scan, and the statement cannot fail. Not when
            // search_path changed in between and the table is unqualified.
            for (const entry of checks.of(
              `${table}`,
              identifierKey(altered![1]!),
            )) {
              if (
                entry.valid &&
                (entry.qualified || !pathChangedBetween(entry.since, position))
              ) {
                return [];
              }
            }

            return [
              finding(
                "blocking",
                "Requires non-null values in existing rows.",
                "Backfill first, then validate the constraint.",
              ),
            ];
          }

          if (retypes) {
            return [
              finding(
                "caution",
                "Changing a column type rewrites the table under an ACCESS EXCLUSIVE lock unless the cast is binary-coercible.",
                "Expect downtime proportional to table size; for large tables add a new column, backfill and switch.",
              ),
            ];
          }

          // A column default applies to future rows only: a catalog change.
          if (/^(?:SET|DROP) DEFAULT\b/.test(alteredText)) {
            return [];
          }

          if (/^VALIDATE CONSTRAINT\b/.test(actionText)) {
            return [
              finding(
                "caution",
                "Validates a constraint against every existing row under a SHARE UPDATE EXCLUSIVE lock, which lets reads and writes go on; the statement fails when a row violates it.",
                "Fix violating rows before the migration runs.",
              ),
            ];
          }

          if (!/^ADD\b/.test(actionText)) {
            return [review];
          }

          // Table constraints may be named (ADD CONSTRAINT …) or anonymous
          // (ADD PRIMARY KEY …); everything else adds a column.
          if (
            /^ADD (?:CONSTRAINT|PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|EXCLUDE)\b/.test(
              actionText,
            )
          ) {
            const constraint = action.match(NAMED_CONSTRAINT)?.[1];
            const keys =
              action.match(KEY_COLUMNS)?.[1]!.match(IDENTIFIERS) ?? undefined;

            if (/\b(?:UNIQUE|PRIMARY KEY)\b/.test(actionText)) {
              if (/\bUSING INDEX\b/.test(actionText)) {
                return KEY_USING_INDEX.test(action)
                  ? [
                      finding(
                        "caution",
                        "Makes an existing unique index the UNIQUE constraint: a catalog change under a brief ACCESS EXCLUSIVE lock, with no table scan.",
                        "The index must be valid: build it with CREATE UNIQUE INDEX CONCURRENTLY first.",
                      ),
                    ]
                  : [review];
              }

              if (freshKey(keys, /\bPRIMARY KEY\b/.test(actionText))) {
                return [fresh];
              }

              return rebuiltAfterRetype(constraint, keys ?? [])
                ? [
                    finding(
                      "caution",
                      "Rebuilds a key dropped earlier in this migration after its columns change type.",
                      "The rebuild scans the table under an ACCESS EXCLUSIVE lock; it fails only if the conversion makes existing values collide.",
                    ),
                  ]
                : [unique];
            }

            const foreign = /\bFOREIGN KEY\b/.test(actionText);

            if (/\bNOT VALID\b/.test(actionText)) {
              return [
                finding(
                  "caution",
                  `Adds a ${foreign ? "foreign key" : /\bCHECK\b/.test(actionText) ? "CHECK constraint" : "constraint"} NOT VALID: rows written from now on are checked, existing rows only when VALIDATE CONSTRAINT runs; adding it takes a brief lock.`,
                  "Validate it in a later statement or migration; VALIDATE CONSTRAINT fails when an existing row violates it.",
                ),
              ];
            }

            if (
              foreign &&
              !!keys?.length &&
              keys.every((key) => nullColumns.has(column(key)))
            ) {
              return [review];
            }

            if (foreign || /\bCHECK\b/.test(actionText)) {
              return rebuiltAfterRetype(constraint, foreign ? keys : undefined)
                ? [rebuild]
                : [
                    finding(
                      "blocking",
                      `Adds a ${foreign ? "foreign key" : "CHECK constraint"} that validates every existing row under a lock; the statement fails when a row violates it.`,
                      "Add it NOT VALID, then run VALIDATE CONSTRAINT in a later statement or migration, which takes a lighter lock.",
                    ),
                  ];
            }

            return [review];
          }

          const added = action.match(ADDED_COLUMN);
          const definition = added ? wordsOf(added[2]!).join(" ") : actionText;
          // Existing rows get a value: a default (not NULL), an identity, a
          // serial or a stored expression. Without one they hold NULL.
          const generated = GENERATED_VALUES.test(definition);
          const filled =
            generated ||
            (/\bDEFAULT\b/.test(definition) &&
              !/\bDEFAULT NULL\b/.test(definition));
          const distinct =
            SERIAL_VALUES.test(definition) ||
            DISTINCT_DEFAULT.test(added?.[2] ?? action);
          const key = /\bPRIMARY KEY\b/.test(definition);
          const results: SQLFinding[] = [];

          if (!filled && (key || /\bNOT NULL\b/.test(definition))) {
            results.push(
              finding(
                "blocking",
                "Requires non-null values in existing rows.",
                "Backfill first, then validate the constraint.",
              ),
            );
          }

          if (filled && !distinct && (key || /\bUNIQUE\b/.test(definition))) {
            results.push(unique);
          }

          // A column-level REFERENCES or CHECK validates the value every
          // existing row gets; NULL passes both.
          for (const [word, kind] of [
            ["REFERENCES", "foreign key"],
            ["CHECK", "CHECK constraint"],
          ] as const) {
            if (filled && new RegExp(`\\b${word}\\b`).test(definition)) {
              results.push(
                finding(
                  "blocking",
                  `Adds a ${kind} that validates every existing row under a lock; the statement fails when a row violates it.`,
                  "Add the column first, then the constraint NOT VALID, and run VALIDATE CONSTRAINT in a later statement or migration.",
                ),
              );
            }
          }

          if (generated) {
            results.push(
              finding(
                "caution",
                "An identity, serial or stored generated column rewrites every existing row.",
                "Add a plain column, backfill in batches, then attach the identity or expression.",
              ),
            );
          } else if (VOLATILE_DEFAULT.test(definition)) {
            results.push(
              finding(
                "caution",
                "A volatile default rewrites every existing row.",
                "Add the column without the default, backfill in batches, then set the default.",
              ),
            );
          }

          if (added && !filled) {
            nullColumns.add(column(added[1]!));
          }

          if (added && distinct) {
            distinctColumns.add(column(added[1]!));
          }

          return results;
        });

        return findings
          .filter(
            (entry, index) =>
              findings.findIndex(
                (other) =>
                  other.level === entry.level &&
                  other.message === entry.message,
              ) === index,
          )
          .sort(
            (left, right) => levelOrder[left.level] - levelOrder[right.level],
          );
      }

      const droppedIndex = code.match(DROPPED_INDEX)?.[1];

      if (droppedIndex !== undefined && createdBefore(position, droppedIndex)) {
        return [];
      }

      if (droppedIndex !== undefined) {
        dropped.add(objectKey(droppedIndex));

        return createdAgain(position, droppedIndex) ? [rebuild] : [destructive];
      }

      if (
        /^(DROP|TRUNCATE|DELETE)\b/.test(text) ||
        /^(?:WITH|MERGE)\b.*\bDELETE\b/.test(text)
      ) {
        return [destructive];
      }

      if (newTable) {
        return [];
      }

      if (/^CREATE UNIQUE INDEX\b/.test(text)) {
        const index = code.match(CREATED_INDEX)?.[1];

        if (
          freshKey(
            code.match(INDEX_COLUMNS)?.[1]?.match(IDENTIFIERS) ?? undefined,
            false,
          )
        ) {
          return [fresh];
        }

        return index !== undefined &&
          dropped.has(objectKey(index)) &&
          retyped.hasPart(`${table}`)
          ? [rebuild]
          : [unique];
      }

      if (/^CREATE INDEX\b/.test(text) && !words.includes("CONCURRENTLY")) {
        return [
          finding(
            "caution",
            "Index construction blocks writes.",
            "Use a dedicated nontransactional migration with CREATE INDEX CONCURRENTLY on large tables.",
          ),
        ];
      }

      // A new enum label changes the catalog only; existing rows are untouched.
      if (/^ALTER TYPE\b.*\bADD VALUE\b/.test(text)) {
        return [];
      }

      // The session's zone, which generate sets to UTC around a conversion.
      if (
        /^(?:SET (?:SESSION |LOCAL )?TIME ?ZONE|RESET TIME ?ZONE)\b/.test(text)
      ) {
        return [];
      }

      if (
        /^(ALTER|UPDATE|INSERT|DO|CALL|WITH|SELECT|MERGE)\b/.test(text) ||
        /^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE|TRIGGER|RULE)\b/.test(
          text,
        )
      ) {
        return [review];
      }

      if (!/^(CREATE|COMMENT|GRANT|REVOKE)\b/.test(text)) {
        return [
          finding(
            "caution",
            "SQL is outside the static migration checks.",
            "Review this statement and exercise it with verify.",
          ),
        ];
      }

      return [];
    },
  );
  const noted = statements.flatMap(
    ({ lineComments }, position): SQLFinding[] => {
      const note = noteText(lineComments, DESTRUCTIVE_LINE);

      return note !== undefined
        ? [
            {
              level: "destructive",
              table: name,
              statement: position + 1,
              message: `Statement ${position + 1}: ${note}`,
              advice:
                "generate needed --allow-destructive for it; back up what it loses before it runs.",
            },
          ]
        : [];
    },
  );
  const notedStatements = new Set(noted.map((note) => note.statement));

  // A caution note (on a shape generate writes it on) replaces what lint finds
  // in its statement, which SQL alone would rate higher.
  return [
    ...noted,
    ...[
      ...findings.filter(
        (finding) =>
          !cautioned.has(finding.statement) &&
          // The note says what is lost; the statement's own rating repeats it.
          !(
            finding.level === "destructive" &&
            notedStatements.has(finding.statement)
          ),
      ),
      ...[...cautioned].map(
        ([statement, message]): SQLFinding => ({
          level: "caution",
          table: name,
          statement,
          message: `Statement ${statement}: ${message}`,
          advice:
            "generate rated it so: the statement takes a lock but loses no data and cannot fail on existing rows.",
        }),
      ),
    ].sort((left, right) => left.statement - right.statement),
  ];
};
