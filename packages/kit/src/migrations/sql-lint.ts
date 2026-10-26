import { parseMigrationSQL } from "./sql";
import type { LintFinding } from "./lint";

export type SQLFinding = LintFinding & { readonly statement: number };

const LEADING_COMMENTS = String.raw`^\s*(?:(?:--[^\n]*(?:\n|$)|/\*[\s\S]*?\*/)\s*)*`;
const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const TABLE_NAME = String.raw`(${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?)`;
const CREATED_TABLE = new RegExp(
  String.raw`${LEADING_COMMENTS}CREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE_NAME}`,
  "i",
);
const TARGET_TABLE = new RegExp(
  String.raw`${LEADING_COMMENTS}(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}\s+)?ON\s+(?:ONLY\s+)?|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?)${TABLE_NAME}`,
  "i",
);

const RECREATED_OBJECT = new RegExp(
  String.raw`(?:\bADD\s+CONSTRAINT\s+(${IDENTIFIER})|\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENTIFIER})\s+ON\b)`,
  "gi",
);
const DROPPED_OBJECT = new RegExp(
  String.raw`${LEADING_COMMENTS}(?:ALTER\s+TABLE\b[^;]*?\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${IDENTIFIER})|DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${IDENTIFIER}))\s*$`,
  "i",
);

/** Normalizes a possibly qualified, possibly quoted table name the way PostgreSQL folds it. */
const tableKey = (name: string): string =>
  (name.match(new RegExp(IDENTIFIER, "g")) ?? [])
    .map((part) =>
      part.startsWith('"')
        ? part.slice(1, -1).replaceAll('""', '"')
        : part.toLowerCase(),
    )
    .join(".");

/** Inspect the SQL that will execute, ignoring comments, strings and function bodies. */
export const lintMigrationSQL = (sql: string, name = "SQL"): SQLFinding[] => {
  // Tables created earlier in the same migration are new and empty, so locks and
  // existing-row preconditions on them cannot block anything.
  const created = new Set<string>();
  const statements = parseMigrationSQL(sql);
  // Constraints and indexes created in this migration: dropping one of them first
  // rebuilds it rather than removing it.
  const recreated = new Set(
    statements.flatMap(({ sql: statement }) =>
      [...statement.matchAll(RECREATED_OBJECT)].map(
        (match) => match[1] ?? match[2]!,
      ),
    ),
  );

  return statements.flatMap(
    ({ words, sql: statement }, position): SQLFinding[] => {
      const text = words.join(" ");
      const createdTable = statement.match(CREATED_TABLE)?.[1];

      if (createdTable) {
        created.add(tableKey(createdTable));
      }

      const target = statement.match(TARGET_TABLE)?.[1];
      const newTable = target !== undefined && created.has(tableKey(target));

      const finding = (
        level: SQLFinding["level"],
        message: string,
        advice: string,
      ): SQLFinding[] => [
        {
          level,
          table: name,
          statement: position + 1,
          message: `Statement ${position + 1}: ${message}`,
          advice,
        },
      ];

      // Renames change the catalog only, under a brief ACCESS EXCLUSIVE lock.
      if (
        /^ALTER (?:TABLE|INDEX|TYPE)\b(?! .*\bDROP\b).*\bRENAME\b/.test(text)
      ) {
        return [];
      }

      const dropped = statement.match(DROPPED_OBJECT);
      const droppedName = dropped?.[1] ?? dropped?.[2];

      if (droppedName !== undefined && recreated.has(droppedName)) {
        return finding(
          "caution",
          "Rebuilds a constraint or index that this migration creates again.",
          "The rebuild scans the table under a lock; on large tables prefer a rename or a concurrent build.",
        );
      }

      if (
        /^(DROP|TRUNCATE|DELETE)\b/.test(text) ||
        /^ALTER TABLE\b.*\bDROP(?:$| (?!DEFAULT\b|NOT\b|IDENTITY\b))/.test(
          text,
        ) ||
        /^WITH\b.*\bDELETE\b/.test(text)
      ) {
        return finding(
          "destructive",
          "Removes data or a database object.",
          "Review the exact SQL and deploy dependent application changes first.",
        );
      }

      if (newTable) {
        return [];
      }

      // `words` keeps keywords only: each ADD clause is what follows its ADD.
      const addedColumns = /^ALTER TABLE\b/.test(text)
        ? text
            .split(/\bADD\b/)
            .slice(1)
            .filter((clause) => !/^\s*CONSTRAINT\b/.test(clause))
        : [];

      if (
        /^ALTER TABLE\b.*\bSET NOT NULL\b/.test(text) ||
        addedColumns.some(
          (clause) =>
            /\bNOT NULL\b/.test(clause) && !/\bDEFAULT\b/.test(clause),
        )
      ) {
        return finding(
          "blocking",
          "Requires non-null values in existing rows.",
          "Backfill first, then validate the constraint.",
        );
      }

      if (addedColumns.length) {
        // Adding a column is a catalog change; a volatile default fills every
        // existing row (PostgreSQL 11+ stores constant defaults without a rewrite).
        return /\bDEFAULT\b.*\b(?:NOW|CLOCK_TIMESTAMP|STATEMENT_TIMESTAMP|TRANSACTION_TIMESTAMP|TIMEOFDAY|RANDOM|GEN_RANDOM_UUID|UUID_GENERATE_V\d|NEXTVAL)\b/.test(
          text,
        )
          ? finding(
              "caution",
              "A volatile default rewrites every existing row.",
              "Add the column without the default, backfill in batches, then set the default.",
            )
          : [];
      }

      if (
        /^CREATE UNIQUE INDEX\b/.test(text) ||
        /^ALTER TABLE\b.*\bADD\b.*\b(?:UNIQUE|PRIMARY KEY)\b/.test(text)
      ) {
        return finding(
          "blocking",
          "Requires unique existing values.",
          "Check and resolve duplicates before applying.",
        );
      }

      if (/^ALTER TABLE\b.*\bALTER COLUMN\b.*\bTYPE\b/.test(text)) {
        return finding(
          "caution",
          "Changing a column type rewrites the table under an ACCESS EXCLUSIVE lock unless the cast is binary-coercible.",
          "Expect downtime proportional to table size; for large tables add a new column, backfill and switch.",
        );
      }

      if (/^CREATE INDEX\b/.test(text) && !words.includes("CONCURRENTLY")) {
        return finding(
          "caution",
          "Index construction blocks writes.",
          "Use a dedicated nontransactional migration with CREATE INDEX CONCURRENTLY on large tables.",
        );
      }

      if (
        /^(ALTER|UPDATE|INSERT|DO|CALL|WITH|SELECT)\b/.test(text) ||
        /^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE|TRIGGER)\b/.test(text)
      ) {
        return finding(
          "caution",
          "Contains a schema change, data operation or executable SQL requiring review.",
          "Verify locks, data preconditions and the upgrade against representative data. SQL lint does not analyze function bodies.",
        );
      }

      if (!/^(CREATE|COMMENT|GRANT|REVOKE)\b/.test(text)) {
        return finding(
          "caution",
          "SQL is outside the static migration checks.",
          "Review this statement and exercise it with verify.",
        );
      }

      return [];
    },
  );
};
