import { parseMigrationSQL } from "./sql";
import type { LintFinding } from "./lint";

export type SQLFinding = LintFinding & { readonly statement: number };

/** Inspect the SQL that will execute, ignoring comments, strings and function bodies. */
export const lintMigrationSQL = (sql: string, name = "SQL"): SQLFinding[] =>
  parseMigrationSQL(sql).flatMap(({ words }, position): SQLFinding[] => {
    const text = words.join(" ");

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

    if (
      /^ALTER TABLE\b.*\b(?:SET NOT NULL|ADD (?:COLUMN )?.*NOT NULL)\b/.test(
        text,
      )
    ) {
      return finding(
        "blocking",
        "Requires non-null values in existing rows.",
        "Backfill first, then validate the constraint.",
      );
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
  });
