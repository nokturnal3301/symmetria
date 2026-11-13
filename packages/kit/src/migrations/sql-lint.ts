/**
 * Lints migration SQL for statements that lock or rewrite large tables, anonymous constraints and
 * volatile defaults, with safer rewrites. Every ALTER TABLE action is reviewed on its own, and
 * comments, string literals and function bodies never take part in the classification.
 */
import { parseMigrationSQL } from "./sql";
import type { LintFinding } from "./lint";

export type SQLFinding = LintFinding & { readonly statement: number };

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
// An explicit cast to a length-limited string type cuts long values instead of failing.
const TRUNCATING_CAST =
  /\bUSING\b[\s\S]*(?:::\s*|\bAS\s+)(?:varchar|character\s+varying|char|character|bpchar)\s*\(\s*\d+\s*\)/i;
// Defaults evaluated per row: PostgreSQL 11+ stores constant and STABLE
// defaults (now(), transaction_timestamp()) without rewriting the table.
const VOLATILE_DEFAULT =
  /\bDEFAULT\b.*\b(?:CLOCK_TIMESTAMP|TIMEOFDAY|RANDOM|RANDOM_NORMAL|GEN_RANDOM_UUID|GEN_RANDOM_BYTES|UUIDV4|UUIDV7|UUID_GENERATE_V1|UUID_GENERATE_V1MC|UUID_GENERATE_V4|NEXTVAL)\b/;

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
  // Columns retyped earlier: re-adding their keys and checks rebuilds what held before.
  const retyped = new Set<string>();
  // Constraints and indexes dropped earlier in this migration.
  const dropped = new Set<string>();
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

  return statements.flatMap(({ words, code }, position): SQLFinding[] => {
    const text = words.join(" ");
    const createdTable = code.match(CREATED_TABLE)?.[1];

    if (createdTable) {
      created.add(tableKey(createdTable));
    }

    const target = code.match(TARGET_TABLE)?.[1];
    const table = target === undefined ? undefined : tableKey(target);
    const newTable = table !== undefined && created.has(table);
    const column = (name: string) => `${table}.${identifierKey(name)}`;

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

    // Renames change the catalog only, under a brief ACCESS EXCLUSIVE lock.
    if (/^ALTER (?:TABLE|INDEX|TYPE)\b(?! .*\bDROP\b).*\bRENAME\b/.test(text)) {
      return [];
    }

    const alteration = code.match(ALTER_TABLE);

    if (alteration) {
      const findings = splitActions(alteration[2]!).flatMap(
        (action): SQLFinding[] => {
          const actionWords = wordsOf(action);
          const actionText = actionWords.join(" ");
          const droppedConstraint = action.match(DROPPED_CONSTRAINT)?.[1];

          if (droppedConstraint !== undefined) {
            dropped.add(objectKey(droppedConstraint));

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

          if (
            /\bNOT NULL\b/.test(definition) &&
            !/\bDEFAULT\b/.test(definition)
          ) {
            return [
              finding(
                "blocking",
                "Requires non-null values in existing rows.",
                "Backfill first, then validate the constraint.",
              ),
            ];
          }

          if (
            /\b(?:GENERATED\b.*\b(?:IDENTITY|STORED)|(?:SMALL|BIG)?SERIAL)\b/.test(
              definition,
            )
          ) {
            return [
              finding(
                "caution",
                "An identity, serial or stored generated column rewrites every existing row.",
                "Add a plain column, backfill in batches, then attach the identity or expression.",
              ),
            ];
          }

          if (VOLATILE_DEFAULT.test(definition)) {
            return [
              finding(
                "caution",
                "A volatile default rewrites every existing row.",
                "Add the column without the default, backfill in batches, then set the default.",
              ),
            ];
          }

          if (/\b(?:UNIQUE|PRIMARY KEY)\b/.test(definition)) {
            return /\bDEFAULT\b/.test(definition) ? [unique] : [];
          }

          if (added && !/\bDEFAULT\b/.test(definition)) {
            nullColumns.add(column(added[1]!));
          }

          return [];
        },
      );

      return findings
        .filter(
          (entry, index) =>
            findings.findIndex(
              (other) =>
                other.level === entry.level && other.message === entry.message,
            ) === index,
        )
        .sort(
          (left, right) => levelOrder[left.level] - levelOrder[right.level],
        );
    }

    const droppedIndex = code.match(DROPPED_INDEX)?.[1];

    if (droppedIndex !== undefined) {
      dropped.add(objectKey(droppedIndex));

      return recreated.has(objectKey(droppedIndex)) ? [rebuild] : [destructive];
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

    if (
      /^(ALTER|UPDATE|INSERT|DO|CALL|WITH|SELECT|MERGE)\b/.test(text) ||
      /^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE|TRIGGER|RULE)\b/.test(text)
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
  });
};
