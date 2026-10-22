import { describe } from "bun:test";
import { queryCompositionTests } from "../../support/query-composition";

describe("SQLite query composition", () => queryCompositionTests("sqlite"));
