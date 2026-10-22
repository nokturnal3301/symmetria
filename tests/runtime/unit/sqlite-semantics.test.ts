import { describe } from "bun:test";
import { querySemanticsTests } from "../../support/query-semantics";

describe("SQLite mutation and NULL semantics", () =>
  querySemanticsTests("sqlite"));
