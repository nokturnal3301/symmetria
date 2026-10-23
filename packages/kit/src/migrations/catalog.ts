import type { QueryExecutor } from "symmetria";
import { normalizeResult } from "symmetria/internal";

export type CatalogOptions = {
  execute: QueryExecutor;
  schemaName?: string;
  metadataSchema?: string;
  metadataTable?: string;
};
export type CatalogConstraint = {
  table_name: string;
  name: string;
  kind: string;
  columns: string[];
  reference_table: string | null;
  reference_schema: string | null;
  reference_columns: string[];
  on_delete: string;
  on_update: string;
  match: string;
  deferrable: boolean;
  initially_deferred: boolean;
  no_inherit: boolean;
  nulls_not_distinct: boolean;
  validated: boolean;
  expression: string | null;
  definition: string;
};

/** Stable catalog representation for drift, replay verification and rollback checks. */
export const readCatalog = async (options: CatalogOptions) => {
  const query = async <Row>(sql: string): Promise<Row[]> =>
    normalizeResult(
      await options.execute({
        sql,
        parameters: [
          options.schemaName ?? null,
          options.metadataSchema ?? "public",
          options.metadataTable ?? "_symmetria_migrations",
        ],
      }),
    ).rows as Row[];

  const filter =
    "namespace.nspname = COALESCE($1, current_schema()) AND NOT (namespace.nspname = $2 AND relation.relname = $3)";
  const tables = await query<{ name: string }>(
    `SELECT relation.relname AS name FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE ${filter} AND relation.relkind IN ('r', 'p') ORDER BY relation.relname COLLATE "C"`,
  );
  const columns = await query<{
    table_name: string;
    column_name: string;
    data_type: string;
    enum_name: string | null;
    enum_schema: string | null;
    not_null: boolean;
    identity: string;
    default: string | null;
  }>(`
    SELECT relation.relname AS table_name, attribute.attname AS column_name,
      format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
      CASE WHEN typ.typtype = 'e' THEN typ.typname ELSE NULL END AS enum_name,
      CASE WHEN typ.typtype = 'e' AND typ.typnamespace <> relation.relnamespace THEN typ_namespace.nspname ELSE NULL END AS enum_schema,
      attribute.attnotnull AS not_null, attribute.attidentity AS identity,
      pg_get_expr(definition.adbin, definition.adrelid) AS default
    FROM pg_attribute attribute JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_type typ ON typ.oid = attribute.atttypid
    JOIN pg_namespace typ_namespace ON typ_namespace.oid = typ.typnamespace
    LEFT JOIN pg_attrdef definition ON definition.adrelid = relation.oid AND definition.adnum = attribute.attnum
    WHERE ${filter} AND relation.relkind IN ('r', 'p') AND attribute.attnum > 0 AND NOT attribute.attisdropped
    ORDER BY relation.relname COLLATE "C", attribute.attname COLLATE "C"`);
  const constraints = await query<CatalogConstraint>(`
    SELECT relation.relname AS table_name, con.conname AS name, con.contype AS kind,
      ARRAY(SELECT att.attname FROM unnest(con.conkey) WITH ORDINALITY k(num, pos) JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.num ORDER BY pos) AS columns,
      target.relname AS reference_table,
      CASE WHEN target.relnamespace = relation.relnamespace THEN NULL ELSE target_namespace.nspname END AS reference_schema,
      ARRAY(SELECT att.attname FROM unnest(con.confkey) WITH ORDINALITY k(num, pos) JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.num ORDER BY pos) AS reference_columns,
      con.confdeltype AS on_delete, con.confupdtype AS on_update, con.confmatchtype AS match,
      con.condeferrable AS deferrable, con.condeferred AS initially_deferred, con.convalidated AS validated,
      con.connoinherit AS no_inherit, COALESCE((SELECT i.indnullsnotdistinct FROM pg_index i WHERE i.indexrelid = con.conindid), false) AS nulls_not_distinct,
      pg_get_expr(con.conbin, con.conrelid) AS expression, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class relation ON relation.oid = con.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_class target ON target.oid = con.confrelid
    LEFT JOIN pg_namespace target_namespace ON target_namespace.oid = target.relnamespace
    WHERE ${filter} AND con.contype IN ('p', 'u', 'f', 'c', 'x')
    ORDER BY relation.relname COLLATE "C", con.conname COLLATE "C"`);
  const indexes = await query<{
    table_name: string;
    name: string;
    valid: boolean;
    ready: boolean;
    definition: string;
    constraint: boolean;
  }>(`
    SELECT relation.relname AS table_name, idx.relname AS name, i.indisvalid AS valid, i.indisready AS ready,
      pg_get_indexdef(i.indexrelid) AS definition,
      EXISTS(SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid AND con.contype IN ('p', 'u', 'x')) AS constraint
    FROM pg_index i JOIN pg_class relation ON relation.oid = i.indrelid JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE ${filter}
    ORDER BY relation.relname COLLATE "C", idx.relname COLLATE "C"`);
  const enumerations = await query<{ name: string; values: string[] }>(`
    SELECT typ.typname AS name, array_agg(enum.enumlabel ORDER BY enum.enumsortorder) AS values
    FROM pg_type typ JOIN pg_namespace namespace ON namespace.oid = typ.typnamespace
    JOIN pg_enum enum ON enum.enumtypid = typ.oid
    WHERE namespace.nspname = COALESCE($1, current_schema()) AND $2::text IS NOT NULL AND $3::text IS NOT NULL
    GROUP BY typ.typname ORDER BY typ.typname COLLATE "C"`);

  return { tables, columns, constraints, indexes, enumerations };
};

export type MigrationCatalog = Awaited<ReturnType<typeof readCatalog>>;
