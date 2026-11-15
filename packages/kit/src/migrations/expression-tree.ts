export type SqlExpression =
  /**
   * A number or string literal; `numeric` marks an unquoted number. `type` is
   * the cast it carried before simplification, which comparison keys ignore
   * unless the type decides what the text means (dates, times, JSON): a cast
   * that changes the literal's value stays a `cast` node instead.
   */
  | {
      readonly kind: "constant";
      readonly value: string;
      readonly numeric: boolean;
      readonly type?: string;
    }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "null" }
  | { readonly kind: "column"; readonly name: string }
  | {
      readonly kind: "cast";
      readonly value: SqlExpression;
      readonly type: string;
    }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly arguments: readonly SqlExpression[];
    }
  | {
      readonly kind: "binary";
      readonly operator: string;
      readonly left: SqlExpression;
      readonly right: SqlExpression;
    }
  | {
      readonly kind: "unary";
      readonly operator: string;
      readonly value: SqlExpression;
    }
  | { readonly kind: "not"; readonly value: SqlExpression }
  | {
      readonly kind: "logical";
      readonly operator: "AND" | "OR";
      readonly values: readonly SqlExpression[];
    }
  | {
      readonly kind: "null-test";
      readonly value: SqlExpression;
      readonly negated: boolean;
    }
  | {
      readonly kind: "truth-test";
      readonly value: SqlExpression;
      readonly test: "TRUE" | "FALSE" | "UNKNOWN";
      readonly negated: boolean;
    }
  | {
      readonly kind: "distinct";
      readonly left: SqlExpression;
      readonly right: SqlExpression;
      readonly negated: boolean;
    }
  | {
      readonly kind: "in";
      readonly value: SqlExpression;
      readonly values: readonly SqlExpression[];
      readonly negated: boolean;
    }
  | {
      readonly kind: "quantified";
      readonly operator: string;
      readonly quantifier: "ANY" | "ALL";
      readonly left: SqlExpression;
      readonly right: SqlExpression;
    }
  | { readonly kind: "array"; readonly values: readonly SqlExpression[] }
  | {
      readonly kind: "between";
      readonly value: SqlExpression;
      readonly lower: SqlExpression;
      readonly upper: SqlExpression;
      readonly negated: boolean;
      readonly symmetric: boolean;
    }
  | {
      readonly kind: "like";
      readonly value: SqlExpression;
      readonly pattern: SqlExpression;
      readonly operator: "LIKE" | "ILIKE";
      readonly negated: boolean;
    }
  | {
      readonly kind: "collate";
      readonly value: SqlExpression;
      readonly collation: string;
    }
  | {
      readonly kind: "case";
      readonly subject: SqlExpression | undefined;
      readonly branches: readonly {
        readonly when: SqlExpression;
        readonly then: SqlExpression;
      }[];
      readonly otherwise: SqlExpression | undefined;
    };

/** Syntax the parser does not model: the caller falls back to the text. */
export class UnsupportedExpression extends Error {}

export const unsupported = (what: string): never => {
  throw new UnsupportedExpression(`unsupported SQL: ${what}`);
};
