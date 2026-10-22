import { describe } from "bun:test";
import { queryJsonSemanticsTests } from "../../support/query-json-semantics";

describe("SQLite JSON and alias semantics", () =>
  queryJsonSemanticsTests("sqlite"));
