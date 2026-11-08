/**
 * "Did you mean" hints for unknown columns and relations in shape callbacks.
 */
import type { TableSnapshot } from "../../schema/assembly";

/** Property reads that generic code performs on any object and must stay silent. */
export const PASSTHROUGH_MEMBERS: ReadonlySet<string> = new Set([
  "then",
  "toJSON",
]);

const distance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, i) => i);

  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;

    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(
        above + 1,
        previous[j - 1]! + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }

  return previous[right.length]!;
};

/** The closest known name: a case-insensitive match, or within two edits. */
export const closestName = (
  name: string,
  candidates: readonly string[],
): string | undefined => {
  const exact = candidates.find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );

  if (exact) {
    return exact;
  }

  let best: { candidate: string; score: number } | undefined;

  for (const candidate of candidates) {
    const score = distance(name.toLowerCase(), candidate.toLowerCase());

    if (score <= 2 && (!best || score < best.score)) {
      best = { candidate, score };
    }
  }

  return best?.candidate;
};

/** Whether a property read on a shape view should be reported as a mistake. */
export const isSilentMember = (property: string): boolean =>
  PASSTHROUGH_MEMBERS.has(property) || property in Object.prototype;

export const unknownMember = (
  table: TableSnapshot,
  property: string,
  columnNames: readonly string[],
): Error => {
  const relations = table.relations.map((relation) => relation.name);
  const suggestion = closestName(property, [...columnNames, ...relations]);
  const available = [
    ...(columnNames.length ? [`columns: ${columnNames.join(", ")}`] : []),
    ...(relations.length ? [`relations: ${relations.join(", ")}`] : []),
  ].join("; ");

  return new Error(
    `symmetria: "${table.name}.${property}" is not a column or relation of "${table.name}"${suggestion ? ` (did you mean "${suggestion}"?)` : ""}. Available ${available}`,
  );
};

/**
 * A column scope that reports unknown members and relation names instead of
 * yielding undefined: for callbacks that see columns only (relation predicates,
 * UPDATE assignments, RETURNING, $scope).
 */
export const columnsOnly = <Scope extends object>(
  table: TableSnapshot,
  columns: Scope,
  where: string,
): Scope =>
  new Proxy(columns, {
    get: (target, property, receiver) => {
      if (
        typeof property !== "string" ||
        Object.hasOwn(target, property) ||
        isSilentMember(property)
      ) {
        return Reflect.get(target, property, receiver);
      }

      if (table.relations.some((relation) => relation.name === property)) {
        throw new Error(
          `symmetria: "${table.name}.${property}" is a relation; ${where} use columns of "${table.name}" only`,
        );
      }

      const names = Object.keys(target);
      const suggestion = closestName(property, names);

      throw new Error(
        `symmetria: "${table.name}.${property}" is not a column of "${table.name}"${suggestion ? ` (did you mean "${suggestion}"?)` : ""}; ${where} use columns of "${table.name}" only. Available columns: ${names.join(", ")}`,
      );
    },
  });
