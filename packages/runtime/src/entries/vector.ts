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

/** pgvector rejects more than 16000 dimensions for the `vector` and `halfvec` types. */
const MAX_DIMENSIONS = 16000;

const vectorCodec = (type: "vector" | "halfvec"): RuntimeCodec =>
  Object.freeze({
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
    parameterCast: type,
  });

const CODECS = Object.freeze({
  vector: vectorCodec("vector"),
  halfvec: vectorCodec("halfvec"),
});

const vectorColumn = (type: "vector" | "halfvec", dimensions?: number) => {
  if (
    dimensions !== undefined &&
    (!Number.isSafeInteger(dimensions) ||
      dimensions < 1 ||
      dimensions > MAX_DIMENSIONS)
  ) {
    throw new Error(
      `symmetria: ${type} dimensions must be an integer between 1 and ${MAX_DIMENSIONS}`,
    );
  }

  return typedColumn<Vector>(
    dimensions === undefined ? type : `${type}(${dimensions})`,
    CODECS[type],
  );
};

/**
 * `vector(1536)` column: embeddings written and read as `number[]`. Dimensions are
 * optional (`vector()` accepts any length) but indexes require a fixed size.
 */
export const vector = (dimensions?: number) =>
  vectorColumn("vector", dimensions);

/**
 * `halfvec(1536)`: the same embeddings in half precision (pgvector 0.7+).
 * Each number takes 2 bytes instead of 4, so the column and its index take
 * about half the space, and HNSW indexes take up to 4,000 dimensions
 * instead of 2,000; the ranking hardly changes. Indexes use the `halfvec_…`
 * operator classes, such as `halfvec_cosine_ops`.
 */
export const halfvec = (dimensions?: number) =>
  vectorColumn("halfvec", dimensions);

Object.defineProperty(vector, COLUMN_BUILDER, {
  value: "vector(1536)",
  enumerable: false,
});
Object.defineProperty(halfvec, COLUMN_BUILDER, {
  value: "halfvec(1536)",
  enumerable: false,
});
