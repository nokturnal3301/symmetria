import { describe } from "bun:test";
import { queryValueTests } from "../../support/query-values";

describe("SQLite value composition", () => queryValueTests("sqlite"));
