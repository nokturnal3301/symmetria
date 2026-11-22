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
const DESTRUCTIVE_LINE = /^--\s*symmetria:\s*destructive:\s*(.*)$/m;
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
const CAUTION_LINE = /^--\s*symmetria:\s*caution:\s*(.*)$/m;

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

/** An identifier the way PostgreSQL folds it: quoted names verbatim, others lower-cased. */
const identifierKey = (name: string): string =>
  name.startsWith('"')
    ? name.slice(1, -1).replaceAll('""', '"')
    : name.toLowerCase();

/** Normalizes a possibly qualified, possibly quoted table name the way PostgreSQL folds it. */
const tableKey = (name: string): string =>
  (name.match(new RegExp(IDENTIFIER, "g")) ?? []).map(identifierKey).join(".");

/** The unqualified object name, for matching drops with re-creations. */
const objectKey = (name: string): string =>
  identifierKey(name.match(new RegExp(IDENTIFIER, "g"))!.at(-1)!);

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

/** Inspect the SQL that will execute, ignoring comments, strings and function bodies. */
export const lintMigrationSQL = (sql: string, name = "SQL"): SQLFinding[] => {
  const statements = parseMigrationSQL(sql);
  // Tables created earlier in the same migration are new and empty, so locks and
  // existing-row preconditions on them cannot block anything.
  const created = new Set<string>();
  // Columns added earlier without a default hold only NULL, which every foreign key accepts.
  const nullColumns = new Set<string>();
  // Columns added earlier whose rows each got their own value (an identity, a
  // volatile default): a unique key over one of them cannot fail.
  const distinctColumns = new Set<string>();
  // Columns retyped earlier: re-adding their keys and checks rebuilds what held before.
  const retyped = new Set<string>();
  // Constraints and indexes dropped earlier in this migration.
  const dropped = new Set<string>();
  // Constraints dropped earlier, by table (following renames of the table).
  const droppedOn = new Map<string, Set<string>>();
  // Statements with a caution note on a shape generate writes it on.
  const cautioned = new Map<number, string>();
  // Constraints and indexes created in this migration: dropping one of them first
  // rebuilds it rather than removing it.
  const recreated = new Set(
    statements.flatMap(({ code }) => {
      const index = code.match(CREATED_INDEX)?.[1];
      const table = code.match(ALTER_TABLE);

      return [
        ...(index ? [objectKey(index)] : []),
        ...(table
          ? splitActions(table[2]!).flatMap((action) => {
              const constraint = action.match(NAMED_CONSTRAINT)?.[1];

              return constraint ? [objectKey(constraint)] : [];
            })
          : []),
      ];
    }),
  );

  const findings = statements.flatMap(
    ({ words, code, sql: written }, position): SQLFinding[] => {
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
          for (const key of known) {
            if (prefix === undefined || key.startsWith(`${prefix}.`)) {
              known.delete(key);
            }
          }
        }
      };

      if (!ALTER_TABLE.test(code) && !KEEPS_VALUES.test(text)) {
        forget();
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
      const fresh = finding(
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
          : [...retyped].some((key) => key.startsWith(`${table}.`)));

      const alteration = code.match(ALTER_TABLE);
      const actions = alteration ? splitActions(alteration[2]!) : [];
      const note = CAUTION_LINE.exec(written)?.[1];

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

          const droppedConstraint = action.match(DROPPED_CONSTRAINT)?.[1];

          if (droppedConstraint !== undefined) {
            dropped.add(objectKey(droppedConstraint));
            droppedOn.set(
              table!,
              (droppedOn.get(table!) ?? new Set()).add(
                objectKey(droppedConstraint),
              ),
            );

            return recreated.has(objectKey(droppedConstraint))
              ? [rebuild]
              : [destructive];
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
              action
                .match(KEY_COLUMNS)?.[1]!
                .match(new RegExp(IDENTIFIER, "g")) ?? undefined;

            if (/\b(?:UNIQUE|PRIMARY KEY)\b/.test(actionText)) {
              if (/\bUSING INDEX\b/.test(actionText)) {
                return [review];
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

            if (
              /\bNOT VALID\b/.test(actionText) ||
              (foreign &&
                !!keys?.length &&
                keys.every((key) => nullColumns.has(column(key))))
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

      if (droppedIndex !== undefined) {
        dropped.add(objectKey(droppedIndex));

        return recreated.has(objectKey(droppedIndex))
          ? [rebuild]
          : [destructive];
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
            code
              .match(INDEX_COLUMNS)?.[1]
              ?.match(new RegExp(IDENTIFIER, "g")) ?? undefined,
            false,
          )
        ) {
          return [fresh];
        }

        return index !== undefined &&
          dropped.has(objectKey(index)) &&
          [...retyped].some((key) => key.startsWith(`${table}.`))
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
  const noted = statements.flatMap(({ sql }, position): SQLFinding[] => {
    const note = DESTRUCTIVE_LINE.exec(sql);

    return note
      ? [
          {
            level: "destructive",
            table: name,
            statement: position + 1,
            message: `Statement ${position + 1}: ${note[1]}`,
            advice:
              "generate needed --allow-destructive for it; back up what it loses before it runs.",
          },
        ]
      : [];
  });
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
            noted.some((note) => note.statement === finding.statement)
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
