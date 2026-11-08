import { postgres as bun } from "../../packages/runtime/src/entries/bun";
import { postgres as pg } from "../../packages/runtime/src/entries/pg";
import {
  testDatabase as isolated,
  type TestDatabaseOptions,
} from "../../packages/kit/src/testing";
import type { BindableSchema } from "../../packages/runtime/src/schema/binding";
import type { SchemaSnapshot } from "../../packages/runtime/src";
export type {
  Driver,
  SessionDriver,
} from "../../packages/runtime/src/entries/driver";

export const postgres = process.env.SYMMETRIA_TEST_DRIVER === "pg" ? pg : bun;

export const testDatabase = <
  Model extends BindableSchema & { $snapshot: () => SchemaSnapshot },
>(
  options: TestDatabaseOptions<Model>,
) => isolated({ ...options, driver: postgres });
