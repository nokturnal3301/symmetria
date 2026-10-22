import type { Driver } from "../query/state";

/** Rebind compiled schema metadata without evaluating declaration callbacks again. */
export const SCHEMA_BIND = Symbol("symmetria.schema.bind");
export type BindableSchema = {
  readonly [SCHEMA_BIND]: (driver: Driver) => unknown;
};

export type DatabaseOptions<Model extends BindableSchema> = {
  readonly schema: Model;
  readonly driver: Driver;
};

/** Bind a reusable schema to a driver, retaining its inferred query API and scopes. */
export const createDatabase = <Model extends BindableSchema>({
  schema: model,
  driver,
}: DatabaseOptions<Model>): ReturnType<Model[typeof SCHEMA_BIND]> => {
  if (!model || typeof model[SCHEMA_BIND] !== "function") {
    throw new Error(
      "symmetria: createDatabase() expects a schema() declaration",
    );
  }

  return model[SCHEMA_BIND](driver) as ReturnType<Model[typeof SCHEMA_BIND]>;
};
