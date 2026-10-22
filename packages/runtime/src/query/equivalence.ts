import { isDeepStrictEqual } from "node:util";
import type { PredicateDescription, ValueNode } from "./expressions";
import type { SelectPlan, TableBinding } from "./state";

const sameParameter = (first: unknown, second: unknown): boolean => {
  if (!isDeepStrictEqual(first, second)) {
    return false;
  }

  if (first === null || typeof first !== "object") {
    return true;
  }

  // Drivers can expose object-key order as text, including inside array parameters.
  const representation = (_key: string, value: unknown): unknown =>
    typeof value === "bigint" ? String(value) : value;

  try {
    return (
      JSON.stringify(first, representation) ===
      JSON.stringify(second, representation)
    );
  } catch {
    return false;
  }
};

/** Bindings and parameter codecs are identities, even when their shapes match. */
export const sameExpression = (
  left: ValueNode | readonly PredicateDescription[],
  right: ValueNode | readonly PredicateDescription[],
  bindings?: ReadonlyMap<TableBinding, TableBinding>,
): boolean => {
  const equivalent = (
    first: unknown,
    second: unknown,
    field?: string,
    correspondence = bindings,
  ): boolean => {
    if (first === second) {
      return true;
    }

    if (field === "binding" || field === "root" || field === "from") {
      return correspondence?.get(first as TableBinding) === second;
    }

    if (field === "scope" || field === "codec") {
      return false;
    }

    if (
      !first ||
      !second ||
      typeof first !== "object" ||
      typeof second !== "object"
    ) {
      return false;
    }

    // Parameter contents are application data, even when they resemble AST nodes.
    if ("kind" in first && first.kind === "parameter") {
      const parameter = first as Extract<ValueNode, { kind: "parameter" }>;
      const other = second as Partial<typeof parameter>;

      return (
        other.kind === "parameter" &&
        parameter.cast === other.cast &&
        sameParameter(parameter.value, other.value)
      );
    }

    if (
      "kind" in first &&
      first.kind === "select" &&
      "kind" in second &&
      second.kind === "select"
    ) {
      const firstQuery = first as SelectPlan;
      const secondQuery = second as SelectPlan;
      const aliases = Object.keys(firstQuery.bindings);
      const localBindings = new Map(correspondence);

      if (aliases.length !== Object.keys(secondQuery.bindings).length) {
        return false;
      }

      for (const alias of aliases) {
        const firstBinding = firstQuery.bindings[alias]!;
        const secondBinding = secondQuery.bindings[alias];

        if (
          !secondBinding ||
          firstBinding.table !== secondBinding.table ||
          firstBinding.alias !== secondBinding.alias ||
          firstBinding.dialect !== secondBinding.dialect ||
          firstBinding.derived !== secondBinding.derived ||
          firstBinding.cte !== secondBinding.cte ||
          firstBinding.cteReference !== secondBinding.cteReference
        ) {
          return false;
        }

        localBindings.set(firstBinding, secondBinding);
      }

      return (
        Object.keys(firstQuery).length === Object.keys(secondQuery).length &&
        Object.keys(firstQuery).every(
          (name) =>
            Object.hasOwn(secondQuery, name) &&
            (name === "bindings" ||
              equivalent(
                firstQuery[name as keyof SelectPlan],
                secondQuery[name as keyof SelectPlan],
                name,
                localBindings,
              )),
        )
      );
    }

    const fields = Object.keys(first);

    return (
      fields.length === Object.keys(second).length &&
      fields.every(
        (name) =>
          Object.hasOwn(second, name) &&
          equivalent(
            (first as Record<string, unknown>)[name],
            (second as Record<string, unknown>)[name],
            name,
            correspondence,
          ),
      )
    );
  };

  return equivalent(left, right);
};
