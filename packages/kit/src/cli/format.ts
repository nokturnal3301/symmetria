import type { SchemaSnapshot } from "symmetria";
import type { MigrationPlan, MigrationStatus, RenameHints } from "../index";
import { canonicalJSON, type MigrationColumn } from "../migrations/snapshot";
import { heading, panel, theme, fitLine, terminalWidth } from "./style";
import { stringWidth } from "bun";

const equal = (left: unknown, right: unknown): boolean =>
  canonicalJSON(left ?? null) === canonicalJSON(right ?? null);

const columnLabel = (column: MigrationColumn): string =>
  [
    column.sqlType,
    column.notNull ? "" : "nullable",
    column.identity ? "identity" : "",
    column.unique ? "unique" : "",
    column.default === undefined ? "" : `default ${column.default}`,
    column.references
      ? `→ ${column.references.table}.${column.references.column} ON DELETE ${column.references.onDelete}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

export const formatDiff = (
  plan: MigrationPlan,
  color = false,
  renames: RenameHints = {},
): string => {
  const { style } = theme(color);

  if (!plan.up.length) {
    return color
      ? `\n  ${style("✓", "success")} No schema changes. ${style("Everything is in sync.", "muted")}\n`
      : "No schema changes.";
  }

  const output: string[] = color
    ? [heading("Schema changes", "code → snapshot", color)]
    : [];
  const previous = new Map(
    plan.before.tables.map((table) => [table.name, table]),
  );
  const next = new Map(plan.after.tables.map((table) => [table.name, table]));

  const marker = (sign: string, text: string) =>
    style(
      `    ${sign} ${text}`,
      sign === "+" ? "success" : sign === "-" ? "danger" : "warning",
    );

  let changed = 0;

  for (const name of [
    ...new Set(
      [...previous.keys()]
        .map((name) => renames.tables?.[name] ?? name)
        .concat([...next.keys()]),
    ),
  ].sort()) {
    const originalName =
      Object.entries(renames.tables ?? {}).find(
        ([, target]) => target === name,
      )?.[0] ?? name;
    const before = previous.get(originalName);
    const after = next.get(name);

    if (equal(before, after)) {
      continue;
    }

    changed++;
    output.push(
      style(
        `  ${before ? (after ? "~" : "-") : "+"} ${originalName === name ? name : `${originalName} → ${name}`}`,
        "accent",
      ),
    );
    const renamedColumns = renames.columns?.[name] ?? {};
    const columns = new Set([
      ...(before?.columns.map(
        (column) => renamedColumns[column.name] ?? column.name,
      ) ?? []),
      ...(after?.columns.map((column) => column.name) ?? []),
    ]);

    for (const columnName of columns) {
      const originalColumnName =
        Object.entries(renamedColumns).find(
          ([, target]) => target === columnName,
        )?.[0] ?? columnName;
      const old = before?.columns.find(
        (column) => column.name === originalColumnName,
      );
      const current = after?.columns.find(
        (column) => column.name === columnName,
      );

      if (equal(old, current)) {
        continue;
      }

      output.push(
        marker(
          old ? (current ? "~" : "-") : "+",
          `${(originalColumnName === columnName ? columnName : `${originalColumnName} → ${columnName}`).padEnd(20)} ${old && current && columnLabel(old) !== columnLabel(current) ? `${columnLabel(old)} → ${columnLabel(current)}` : columnLabel(current ?? old!)}`,
        ),
      );
    }

    if (!equal(before?.primaryKey ?? [], after?.primaryKey ?? [])) {
      output.push(
        marker(
          before?.primaryKey.length
            ? after?.primaryKey.length
              ? "~"
              : "-"
            : "+",
          `primary key          (${(before?.primaryKey ?? []).join(", ")}) → (${(after?.primaryKey ?? []).join(", ")})`,
        ),
      );
    }

    for (const kind of ["indexes", "checks"] as const) {
      const names = new Set([
        ...(before?.[kind]?.map((entry) => entry.sqlName) ?? []),
        ...(after?.[kind]?.map((entry) => entry.sqlName) ?? []),
      ]);

      for (const name of names) {
        const old = before?.[kind]?.find((entry) => entry.sqlName === name);
        const current = after?.[kind]?.find((entry) => entry.sqlName === name);

        if (equal(old, current)) {
          continue;
        }

        const entry = current ?? old!;
        const description =
          "expression" in entry
            ? `CHECK (${entry.expression})`
            : `${entry.unique ? "UNIQUE " : ""}${entry.method} (${entry.keys.join(", ")})${entry.include.length ? ` INCLUDE (${entry.include.join(", ")})` : ""}${entry.where ? ` WHERE ${entry.where}` : ""}`;
        output.push(
          marker(old ? (current ? "~" : "-") : "+", `${name}  ${description}`),
        );
      }
    }

    output.push("");
  }

  for (const name of new Set(
    [...plan.before.enumerations, ...plan.after.enumerations].map(
      (entry) => entry.name,
    ),
  )) {
    const before = plan.before.enumerations.find(
      (entry) => entry.name === name,
    );
    const after = plan.after.enumerations.find((entry) => entry.name === name);

    if (!equal(before, after)) {
      output.push(
        marker(
          before ? (after ? "~" : "-") : "+",
          `enum ${name}: ${(before?.values ?? []).join(" | ")} → ${(after?.values ?? []).join(" | ")}`,
        ),
      );
    }
  }

  output.push(
    `  ${style(`${changed} tables changed`, "violet")} ${style("·", "muted")} ${style(`${plan.up.length} SQL statements`, "accent")}`,
  );

  if (color) {
    output.push(
      `  ${style("+ added", "success")}  ${style("~ modified", "warning")}  ${style("− removed", "danger")}\n`,
    );
  }

  return output.join("\n");
};

export const formatSchema = (
  snapshot: SchemaSnapshot,
  name?: string,
  relationsOnly = false,
  color = false,
): string => {
  const { style } = theme(color);
  const tables = name
    ? snapshot.tables.filter(
        (table) => table.name === name || table.sqlName === name,
      )
    : snapshot.tables;

  if (name && !tables.length) {
    throw new Error(`symmetria: unknown table "${name}"`);
  }

  if (relationsOnly) {
    return (
      tables
        .flatMap((table) =>
          table.relations.map(
            (relation) =>
              `  ${style(`${table.name}.${relation.name}`, "accent")} ${style(relation.kind === "one" ? "──" : "──<", "violet")} ${style(relation.target, "success")}${relation.kind === "through" ? style(` through ${relation.junction}`, "muted") : ""}`,
          ),
        )
        .join("\n") || "No relations."
    );
  }

  return (
    tables
      .map((table) =>
        [
          color
            ? heading(
                table.name,
                `${table.columns.length} columns${table.name === table.sqlName ? "" : ` · ${table.sqlName}`}`,
                color,
              )
            : `  ${table.name}${table.name === table.sqlName ? "" : ` (${table.sqlName})`}`,
          ...table.columns.map(
            (column, position) =>
              `  ${style(position === table.columns.length - 1 ? "└─" : "├─", "border")} ${style(column.name.padEnd(20), column.primaryKey ? "strong" : "accent")} ${[style(column.sqlType, "violet"), column.primaryKey ? style("primary key", "warning") : "", column.unique ? style("unique", "success") : "", column.notNull ? "" : style("nullable", "muted"), column.references ? style(`→ ${column.references.table}.${column.references.column}`, "accent") : "", column.default ? style(`default ${column.default.kind === "sql" ? column.default.sql : JSON.stringify(column.default.value, (_name, value) => (typeof value === "bigint" ? String(value) : value))}`, "muted") : ""].filter(Boolean).join(style(" · ", "border"))}`,
          ),
          ...(table.relations.length
            ? [
                "",
                `  ${style("Relations", "violet")}`,
                ...table.relations.map(
                  (relation) =>
                    `    ${style(relation.name.padEnd(20), "accent")} ${style(relation.kind === "through" ? "many" : relation.kind, "muted")} ${style(relation.target, "success")}${relation.kind === "through" ? style(` through ${relation.junction}`, "muted") : ""}`,
                ),
              ]
            : []),
          ...(table.indexes?.length
            ? [
                "",
                `  ${style("Indexes", "violet")}`,
                ...table.indexes.map(
                  (index) =>
                    `    ${style(index.sqlName, "accent")}  ${style(`${index.unique ? "UNIQUE " : ""}${index.method}`, "success")} (${index.keys.join(", ")})`,
                ),
              ]
            : []),
          ...(table.checks?.length
            ? [
                "",
                `  ${style("Checks", "violet")}`,
                ...table.checks.map(
                  (check) =>
                    `    ${style(check.sqlName, "accent")}  ${style(check.expression, "muted")}`,
                ),
              ]
            : []),
        ].join("\n"),
      )
      .join("\n\n") || "No tables."
  );
};

export const formatStatus = (
  statuses: readonly MigrationStatus[],
  color = false,
): string => {
  const { style } = theme(color);

  if (!statuses.length) {
    return `${heading("Migration history", "", color)}  ${style("○ No migrations yet.", "muted")}\n`;
  }

  const applied = statuses.filter((entry) => entry.status === "applied").length;
  const pending = statuses.filter((entry) => entry.status === "pending").length;
  const incomplete = statuses.length - applied - pending;

  return [
    heading("Migration history", `${statuses.length} total`, color),
    ...statuses.map(
      (entry) =>
        `  ${style(entry.status === "applied" ? "✓" : "○", entry.status === "applied" ? "success" : "warning")} ${style(entry.id.padEnd(36), "strong")} ${style(entry.status, entry.status === "applied" ? "success" : "warning")}${entry.status === "incomplete" ? ` · ${entry.direction} · ${entry.statement} confirmed statements · repair required` : entry.appliedAt ? style(` · ${entry.appliedAt.toISOString()}`, "muted") : ""}`,
    ),
    "",
    `  ${style(`${applied} applied`, "success")} ${style("·", "muted")} ${style(`${pending} pending`, pending ? "warning" : "muted")}${incomplete ? ` · ${style(`${incomplete} incomplete`, "warning")}` : ""}\n`,
  ].join("\n");
};

export const formatDashboard = (
  details: {
    address: string;
    connection: "connected" | "offline" | "unavailable";
    snapshot: SchemaSnapshot | undefined;
    migrations: string;
    applied?: number;
    local?: number;
    pending: number;
    changes: number | undefined;
    config: string;
  },
  color = false,
  frame = -10,
): string => {
  const { style, brand } = theme(color);
  const tables = details.snapshot?.tables;

  const count = (
    value: number,
    label: string,
    tone: "accent" | "violet" | "pink",
  ) => `${style(String(value), tone)} ${style(label, "muted")}`;

  const separator = style("  ·  ", "border");
  const address = `${style("●", details.connection === "connected" ? "connected" : details.connection === "unavailable" ? "danger" : "muted")} ${details.address}`;

  if (process.stdout.rows && process.stdout.rows < 16) {
    return `  ${brand(frame)}\n  ${address}`;
  }

  const width = terminalWidth();

  if (width >= 72) {
    const cardWidth = Math.floor((width - 4) / 3);

    const card = (
      title: string,
      value: string,
      subtitle: string,
      tone: "accent" | "violet" | "pink",
    ): string[] => {
      const fill = (line: string) => {
        const content = fitLine(line, cardWidth - 4);

        return `${style("│", "border")} ${content}${" ".repeat(cardWidth - 4 - stringWidth(content))} ${style("│", "border")}`;
      };

      return [
        `${style("╭─ ", "border")}${style(title, tone)}${style(` ${"─".repeat(cardWidth - title.length - 5)}╮`, "border")}`,
        fill(value),
        fill(subtitle),
        style(`╰${"─".repeat(cardWidth - 2)}╯`, "border"),
      ];
    };

    const cards = [
      card(
        "SCHEMA",
        `${style(String(tables?.length ?? "—"), "strong")} ${style("tables", "accent")}`,
        tables
          ? `${tables.reduce((total, table) => total + table.relations.length, 0)} relations${cardWidth >= 28 ? ` · ${tables.reduce((total, table) => total + (table.indexes?.length ?? 0), 0)} indexes` : ""}`
          : "Configure a schema",
        "accent",
      ),
      card(
        "MIGRATIONS",
        details.connection === "unavailable"
          ? style("! Unavailable", "danger")
          : `${style(String(details.connection === "connected" ? (details.applied ?? 0) : (details.local ?? 0)), "strong")} ${style(details.connection === "connected" ? "applied" : "local", "violet")}`,
        style(
          details.connection === "connected"
            ? details.pending
              ? `${details.pending} pending`
              : "✓ Up to date"
            : details.connection === "offline"
              ? "Database offline"
              : "Check connection",
          details.pending ? "warning" : "muted",
        ),
        "violet",
      ),
      card(
        "CHANGES",
        details.changes === 0
          ? style("✓ In sync", "success")
          : `${style(String(details.changes ?? "—"), "strong")} ${style("statements", "pink")}`,
        style("code → snapshot", "muted"),
        "pink",
      ),
    ];

    return [
      `  ${brand(frame)}  ${style("/ PostgreSQL toolkit", "muted")}`,
      `  ${fitLine(address, width)}`,
      "",
      ...cards[0]!.map(
        (_line, index) => `  ${cards.map((card) => card[index]).join("  ")}`,
      ),
      ...(details.connection === "unavailable"
        ? [`  ${style(fitLine(details.migrations, width), "danger")}`]
        : []),
      `  ${style(fitLine(details.config, width), "muted")}`,
    ].join("\n");
  }

  return panel(
    [
      `${brand(frame)}  ${style("/  PostgreSQL toolkit", "muted")}`,
      address,
      "",
      `${style("Schema      ", "muted")}${
        tables
          ? [
              count(tables.length, "tables", "accent"),
              count(
                tables.reduce(
                  (total, table) => total + table.relations.length,
                  0,
                ),
                "relations",
                "violet",
              ),
              count(
                tables.reduce(
                  (total, table) => total + (table.indexes?.length ?? 0),
                  0,
                ),
                "indexes",
                "pink",
              ),
            ].join(separator)
          : "not configured"
      }`,
      `${style("Migrations  ", "muted")}${style(details.migrations, details.connection === "unavailable" ? "danger" : details.pending ? "warning" : details.connection === "connected" ? "success" : "muted")}`,
      `${style("Changes     ", "muted")}${style(details.changes === undefined ? "schema not configured" : details.changes ? `${details.changes} SQL statements since last snapshot` : "✓ In sync with the latest snapshot", details.changes ? "warning" : details.changes === 0 ? "success" : "muted")}`,
      style(details.config, "muted"),
    ],
    color,
  );
};

export const formatCreated = (
  directory: string,
  files: readonly string[],
  color = false,
): string => {
  const { style } = theme(color);

  return [
    `\n  ${style("✓", "success")} ${style("Created", "strong")} ${style(directory, "accent")}`,
    "",
    ...files.map(
      (file, position) =>
        `    ${style(position === files.length - 1 ? "└─" : "├─", "border")} ${style(file, "violet")}`,
    ),
    "",
  ].join("\n");
};

export const formatExecution = (
  migrationIdentifiers: readonly string[],
  action: "Applied" | "Reverted",
  durationMs: number,
  color = false,
): string => {
  const { style } = theme(color);

  if (!migrationIdentifiers.length) {
    return `\n  ${style("✓", "success")} ${action === "Applied" ? "Database is up to date." : "No applied migrations."}\n`;
  }

  return [
    heading(
      action === "Applied" ? "Migrations applied" : "Migrations reverted",
      `${durationMs} ms`,
      color,
    ),
    ...migrationIdentifiers.map(
      (identifier) =>
        `  ${style("✓", "success")} ${style(identifier, "strong")}`,
    ),
    "",
    `  ${style(`${action} ${migrationIdentifiers.length} migrations`, "success")} ${style(`in ${durationMs} ms`, "muted")}${action === "Applied" ? " · Database is up to date." : ""}\n`,
  ].join("\n");
};

export const formatHelp = (help: string, color = false): string => {
  const { style, brand } = theme(color);

  return (
    `\n  ${brand()} ${style("/ PostgreSQL toolkit", "muted")}\n\n` +
    help
      .replace(
        /^symmetria <command>/,
        `  ${style("Usage", "violet")}  symmetria ${style("<command>", "accent")}`,
      )
      .split("\n")
      .map((line) =>
        line.replace(
          /^(  )(--[\w-]+|[a-z]+)(.*?)( {2,})(.+)$/,
          (
            _match,
            indent: string,
            command: string,
            argument: string,
            spacing: string,
            description: string,
          ) =>
            `${indent}${style(command, "accent")}${style(argument, "violet")}${spacing}${style(description, "muted")}`,
        ),
      )
      .join("\n")
  );
};
