/**
 * Catalog queries that only introspection needs on top of readCatalog: column
 * declaration order, generated columns, partitioning and structured index details.
 */
import { normalizeResult } from "symmetria/internal";
import {
  readCatalog,
  readExtensions,
  type CatalogOptions,
} from "../migrations/catalog";

export type ColumnLayoutRow = {
  table_name: string;
  column_name: string;
  position: number;
  /** attgenerated: '' for ordinary columns, 's' for stored generated columns. */
  generated: string;
};

export type TableDetailRow = {
  name: string;
  /** relkind: 'r' ordinary table, 'p' partitioned parent. */
  kind: string;
  partition: boolean;
};

export type IndexDetailRow = {
  table_name: string;
  index_name: string;
  is_unique: boolean;
  nulls_not_distinct: boolean;
  method: string;
  keys: string[];
  /** indoption bits per key: 1 = DESC, 2 = NULLS FIRST. */
  options: number[];
  included: string[];
  /** Non-default operator class per key, null when the default applies. */
  opclasses: (string | null)[];
  /** Collation per key when it differs from the key's own (a `COLLATE` in the definition), else null. */
  collations: (string | null)[];
  /** Storage parameters as `name=value` strings, or null. */
  reloptions: string[] | null;
  predicate: string | null;
  definition: string;
};

const query = async <Row>(
  options: CatalogOptions,
  sql: string,
): Promise<Row[]> =>
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

/** Physical column order and generated-column markers; kept apart from readCatalog, whose rows are compared across databases. */
export const readColumnLayout = (options: CatalogOptions) =>
  query<ColumnLayoutRow>(
    options,
    `SELECT relation.relname AS table_name, attribute.attname AS column_name,
      attribute.attnum::integer AS position, attribute.attgenerated::text AS generated
    FROM pg_attribute attribute JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE ${filter} AND relation.relkind IN ('r', 'p') AND attribute.attnum > 0 AND NOT attribute.attisdropped
    ORDER BY relation.relname COLLATE "C", attribute.attnum`,
  );

export const readTableDetails = (options: CatalogOptions) =>
  query<TableDetailRow>(
    options,
    `SELECT relation.relname AS name, relation.relkind::text AS kind, relation.relispartition AS partition
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE ${filter} AND relation.relkind IN ('r', 'p')
    ORDER BY relation.relname COLLATE "C"`,
  );

/** Every non-primary-key index with its keys, ordering flags, INCLUDE columns and predicate. */
export const readIndexDetails = (options: CatalogOptions) =>
  query<IndexDetailRow>(
    options,
    `SELECT relation.relname AS table_name, indexrelation.relname AS index_name,
      index.indisunique AS is_unique, COALESCE((to_jsonb(index)->>'indnullsnotdistinct')::boolean, false) AS nulls_not_distinct, accessmethod.amname AS method,
      ARRAY(SELECT pg_get_indexdef(index.indexrelid, position, true)
        FROM generate_series(1, index.indnkeyatts) position) AS keys,
      ARRAY(SELECT index.indoption[position - 1]::integer
        FROM generate_series(1, index.indnkeyatts) position) AS options,
      ARRAY(SELECT pg_get_indexdef(index.indexrelid, position, true)
        FROM generate_series(index.indnkeyatts + 1, index.indnatts) position) AS included,
      ARRAY(SELECT CASE WHEN opclass.opcdefault THEN NULL ELSE opclass.opcname::text END
        FROM unnest(index.indclass::oid[]) WITH ORDINALITY classes(oid, position)
        JOIN pg_opclass opclass ON opclass.oid = classes.oid ORDER BY position) AS opclasses,
      ARRAY(SELECT CASE
          WHEN index.indcollation[position - 1] = 0 THEN NULL
          WHEN index.indkey[position - 1] <> 0 THEN (SELECT CASE WHEN keycolumn.attcollation = index.indcollation[position - 1] THEN NULL ELSE collation_entry.collname::text END
            FROM pg_attribute keycolumn WHERE keycolumn.attrelid = index.indrelid AND keycolumn.attnum = index.indkey[position - 1])
          WHEN strpos(pg_get_indexdef(index.indexrelid, 0, true), pg_get_indexdef(index.indexrelid, position, true) || ' COLLATE ') > 0 THEN collation_entry.collname::text
          ELSE NULL END
        FROM generate_series(1, index.indnkeyatts) position
        LEFT JOIN pg_collation collation_entry ON collation_entry.oid = index.indcollation[position - 1]
        ORDER BY position) AS collations,
      indexrelation.reloptions::text[] AS reloptions,
      pg_get_expr(index.indpred, index.indrelid, true) AS predicate,
      pg_get_indexdef(index.indexrelid) AS definition
    FROM pg_index index
    JOIN pg_class relation ON relation.oid = index.indrelid
    JOIN pg_class indexrelation ON indexrelation.oid = index.indexrelid
    JOIN pg_am accessmethod ON accessmethod.oid = indexrelation.relam
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE ${filter} AND NOT index.indisprimary
    ORDER BY relation.relname COLLATE "C", indexrelation.relname COLLATE "C"`,
  );

/** Objects `pull` cannot declare but must report: views, materialized views and triggers. */
export type UndeclaredObjectRow = {
  kind: "view" | "materialized view" | "trigger";
  name: string;
  /** The table a trigger belongs to. */
  table_name: string | null;
  definition: string;
};

export const readUndeclaredObjects = (options: CatalogOptions) =>
  query<UndeclaredObjectRow>(
    options,
    `SELECT * FROM (
      SELECT CASE relation.relkind WHEN 'v' THEN 'view' ELSE 'materialized view' END AS kind,
        relation.relname AS name, NULL::name AS table_name,
        pg_get_viewdef(relation.oid, true) AS definition
      FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE ${filter} AND relation.relkind IN ('v', 'm')
        AND NOT EXISTS (SELECT 1 FROM pg_depend dependency
          WHERE dependency.objid = relation.oid AND dependency.deptype = 'e')
      UNION ALL
      SELECT 'trigger', trigger.tgname, relation.relname, pg_get_triggerdef(trigger.oid, true)
      FROM pg_trigger trigger JOIN pg_class relation ON relation.oid = trigger.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE ${filter} AND NOT trigger.tgisinternal
    ) objects
    ORDER BY kind, name COLLATE "C"`,
  );

export type PullCatalog = Awaited<ReturnType<typeof readCatalog>> & {
  schemaName: string;
  /** Tables of the schema left out through `ignoreTables`. */
  ignored?: string[];
  layout: ColumnLayoutRow[];
  details: TableDetailRow[];
  indexDetails: IndexDetailRow[];
  extensions: { name: string; schema: string }[];
  undeclared: UndeclaredObjectRow[];
};

/**
 * Everything `pull` needs in one round of queries. Tables in `ignoreTables`
 * are left out with their columns, constraints, indexes and triggers, and so
 * are enum types only they use; foreign keys of other tables that point to
 * them stay in, for the model to report.
 */
export const readPullCatalog = async (
  options: CatalogOptions,
): Promise<PullCatalog> => {
  const [schemaRow] = await query<{ name: string }>(
    options,
    "SELECT COALESCE($1, current_schema()) AS name WHERE $2::text IS NOT NULL AND $3::text IS NOT NULL",
  );
  const catalog = await readCatalog({ ...options, ignoreTables: [] });
  const layout = await readColumnLayout(options);
  const details = await readTableDetails(options);
  const indexDetails = await readIndexDetails(options);
  const extensions = await readExtensions(options);
  const undeclared = await readUndeclaredObjects(options);
  const ignoreTables = new Set(options.ignoreTables ?? []);

  const kept = <Row extends { table_name?: string | null; name?: string }>(
    rows: Row[],
  ): Row[] =>
    rows.filter((row) => !ignoreTables.has(row.table_name ?? row.name ?? ""));

  const columns = kept(catalog.columns);
  const ignoredEnumerations = new Set(
    catalog.columns
      .filter(
        (column) =>
          column.enum_name &&
          ignoreTables.has(column.table_name) &&
          !columns.some((entry) => entry.enum_name === column.enum_name),
      )
      .map((column) => column.enum_name),
  );

  return {
    tables: kept(catalog.tables),
    columns,
    constraints: kept(catalog.constraints),
    indexes: kept(catalog.indexes),
    enumerations: catalog.enumerations.filter(
      (enumeration) => !ignoredEnumerations.has(enumeration.name),
    ),
    schemaName: schemaRow?.name ?? options.schemaName ?? "public",
    ignored: catalog.tables
      .filter((table) => ignoreTables.has(table.name))
      .map((table) => table.name),
    layout: kept(layout),
    details: kept(details),
    indexDetails: kept(indexDetails),
    extensions,
    undeclared: kept(undeclared),
  };
};
