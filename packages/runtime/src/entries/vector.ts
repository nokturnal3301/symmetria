/**
 * `symmetria/vector`: the pgvector column type. Distance methods live on vector
 * columns (`embedding.cosineDistance(query)`), operator classes and HNSW/IVFFlat
 * indexes on `index()`, and `schema(defs, { extensions: ["vector"] })` makes
 * migrations create the extension.
 */
import type { RuntimeCodec } from "../query/codecs";
import { COLUMN_BUILDER, typedColumn, type Vector } from "../schema/column";

export type { Vector } from "../schema/column";
export { operatorClass, type OperatorClassKey } from "../schema/indexes";

/** The PostgreSQL extension that provides the type: `schema(defs, { extensions: [VECTOR_EXTENSION] })`. */
export const VECTOR_EXTENSION = "vector" as const;

/** pgvector rejects more than 16000 dimensions for the `vector` type. */
const MAX_DIMENSIONS = 16000;

const vectorCodec: RuntimeCodec = Object.freeze({
  encode: (value: unknown): unknown => {
    if (
      !Array.isArray(value) ||
      value.some(
        (component) =>
          typeof component !== "number" || !Number.isFinite(component),
      )
    ) {
      throw new Error(
        "symmetria: vector values must be arrays of finite numbers",
      );
    }

    // Arrays would be sent as PostgreSQL array literals; pgvector reads `[a,b,c]` text.
    return `[${value.join(",")}]`;
  },
  decode: (value: unknown): unknown => {
    if (typeof value === "string") {
      return JSON.parse(value) as number[];
    }

    if (Array.isArray(value)) {
      return value.map(Number);
    }

    throw new Error("symmetria: unexpected vector value from the driver");
  },
  parameterCast: "vector",
});

/**
 * `vector(1536)` column: embeddings written and read as `number[]`. Dimensions are
 * optional (`vector()` accepts any length) but indexes require a fixed size.
 */
export const vector = (dimensions?: number) => {
  if (
    dimensions !== undefined &&
    (!Number.isSafeInteger(dimensions) ||
      dimensions < 1 ||
      dimensions > MAX_DIMENSIONS)
  ) {
    throw new Error(
      `symmetria: vector dimensions must be an integer between 1 and ${MAX_DIMENSIONS}`,
    );
  }

  return typedColumn<Vector>(
    dimensions === undefined ? "vector" : `vector(${dimensions})`,
    vectorCodec,
  );
};

Object.defineProperty(vector, COLUMN_BUILDER, {
  value: "vector(1536)",
  enumerable: false,
});
