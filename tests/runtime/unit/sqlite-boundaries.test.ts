import { describe } from "bun:test";
import { queryBoundaryTests } from "../../support/query-boundaries";

describe("SQLite query boundaries", () => queryBoundaryTests("sqlite"));
