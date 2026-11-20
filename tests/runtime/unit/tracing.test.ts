import { beforeEach, expect, test } from "bun:test";
import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  createDatabase,
  createProfiler,
  schema,
  table,
  int,
  text,
} from "../../../packages/runtime/src";
import type {
  Driver,
  TransactionDriver,
} from "../../../packages/runtime/src/query/plan/types";
import { traced } from "../../../packages/runtime/src/entries/opentelemetry";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer("symmetria-test");

const declared = schema({
  users: table({ id: int.auto, name: text }),
  "audit.events": table({ id: int.auto, note: text }),
});

/** A driver that answers every statement with one row, or fails on demand. */
const stub = (fail?: (sql: string) => unknown): Driver => {
  const execute: Driver["execute"] = async ({ sql }) => {
    const error = fail?.(sql);

    if (error) {
      throw error;
    }

    return [{ id: 1, name: "Ada" }];
  };
  const scoped: TransactionDriver = {
    execute,
    transaction: (callback) => callback(scoped),
  };

  return {
    execute,
    close: async () => {},
    transaction: (callback) => callback(scoped),
  };
};

const spans = () =>
  exporter.getFinishedSpans().map((span) => ({
    name: span.name,
    parent: exporter
      .getFinishedSpans()
      .find(
        (other) =>
          other.spanContext().spanId === span.parentSpanContext?.spanId,
      )?.name,
    attributes: span.attributes,
    status: span.status.code,
  }));

beforeEach(() => exporter.reset());

test("every statement is a client span named after its operation and table", async () => {
  const database = createDatabase({
    schema: declared,
    driver: traced(stub(), { tracer, attributes: { "db.namespace": "app" } }),
  });

  await tracer.startActiveSpan("GET /users", async (request) => {
    await database.users((user) => ({ name: user.name }), {
      where: (user) => user.name.is("Ada"),
    });
    await database.users.insert({ name: "secret value" });
    request.end();
  });

  const [select, insert] = exporter.getFinishedSpans();

  expect(select!.kind).toBe(SpanKind.CLIENT);
  expect(spans().slice(0, 2)).toEqual([
    {
      name: "SELECT users",
      parent: "GET /users",
      attributes: {
        "db.system.name": "postgresql",
        "db.namespace": "app",
        "db.operation.name": "SELECT",
        "db.query.summary": "SELECT users",
        "db.collection.name": "users",
        "db.query.text":
          'SELECT "users"."name" AS "name"\nFROM "users" AS "users"\nWHERE "users"."name" = $1',
        "db.response.returned_rows": 1,
      },
      status: SpanStatusCode.UNSET,
    },
    expect.objectContaining({ name: "INSERT users", parent: "GET /users" }),
  ]);
  // Values travel as parameters and never reach a span.
  expect(JSON.stringify(insert!.attributes)).not.toContain("secret value");
});

test("statements of a transaction are children of its span", async () => {
  const database = createDatabase({
    schema: declared,
    driver: traced(stub(), { tracer, text: false }),
  });

  await database.$transaction(async (transaction) => {
    await transaction.users.insert({ name: "Ada" });
    await transaction.$transaction(async (nested) => {
      await nested.users.byId(1).delete();
    });
  });

  expect(
    spans().map(({ name, parent, attributes }) => ({
      name,
      parent,
      text: "db.query.text" in attributes,
    })),
  ).toEqual([
    { name: "INSERT users", parent: "transaction", text: false },
    { name: "DELETE users", parent: "savepoint", text: false },
    { name: "savepoint", parent: "transaction", text: false },
    { name: "transaction", parent: undefined, text: false },
  ]);
});

test("a failed statement marks its span and the transaction around it", async () => {
  const refused = Object.assign(new Error("duplicate key"), { code: "23505" });
  const database = createDatabase({
    schema: declared,
    driver: traced(
      stub((sql) => (sql.startsWith("INSERT") ? refused : undefined)),
      { tracer },
    ),
  });

  await expect(
    database.$transaction((transaction) =>
      transaction.users.insert({ name: "Ada" }),
    ),
  ).rejects.toThrow("duplicate key");

  const [statement, transaction] = exporter.getFinishedSpans();

  expect(statement!.status.code).toBe(SpanStatusCode.ERROR);
  expect(statement!.attributes).toMatchObject({
    "db.response.status_code": "23505",
    "error.type": "23505",
  });
  expect(statement!.events.map((event) => event.name)).toEqual(["exception"]);
  expect(transaction!.name).toBe("transaction");
  expect(transaction!.status.code).toBe(SpanStatusCode.ERROR);
});

test("a table in another schema keeps its qualified name", async () => {
  const database = createDatabase({
    schema: declared,
    driver: traced(stub(), { tracer }),
  });

  await database["audit.events"]((event) => ({ note: event.note }));

  expect(spans()[0]!.attributes["db.collection.name"]).toBe("audit.events");
});

test("the profiler still sees queries through a traced driver", async () => {
  const profiler = createProfiler();
  const database = createDatabase({
    schema: declared,
    driver: traced(profiler.driver(stub()), { tracer }),
  });

  await profiler.trace("job", () =>
    database.users((user) => ({ name: user.name })),
  );

  const [request] = profiler.snapshot();

  expect(request!.queries).toHaveLength(1);
  expect(request!.queries[0]!.kind).toBe("select");
  expect(spans().map((span) => span.name)).toEqual(["SELECT users"]);
});
