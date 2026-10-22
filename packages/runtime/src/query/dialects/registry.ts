import type { Dialect, MutationPlan, SelectPlan } from "../state";
import { planDialect } from "../dialect";
import { postgresDialect } from "./postgres";
import { sqliteDialect } from "./sqlite";
import type { DialectStrategy } from "./types";

const registry = new Map<string, DialectStrategy>();
const registered = new WeakMap<DialectStrategy, DialectStrategy>();

/** Registers an immutable snapshot; registering the same object twice is a no-op. */
export const registerDialect = (strategy: DialectStrategy): void => {
  if (registered.has(strategy)) {
    return;
  }

  if (!strategy || typeof strategy.name !== "string" || !strategy.name) {
    throw new Error("symmetria: a dialect requires a nonempty name");
  }

  const existing = registry.get(strategy.name);

  if (existing && existing !== strategy) {
    throw new Error(
      `symmetria: dialect "${strategy.name}" is already registered`,
    );
  }

  const snapshot =
    existing ??
    Object.freeze({
      ...strategy,
      capabilities: Object.freeze({ ...strategy.capabilities }),
      textCast: Object.freeze({ ...strategy.textCast }),
    });
  registered.set(strategy, snapshot);
  registry.set(snapshot.name, snapshot);
};

registerDialect(postgresDialect);
registerDialect(sqliteDialect);

export const resolveDialect = (name: Dialect | undefined): DialectStrategy => {
  const strategy = registry.get(name ?? "postgres");

  if (!strategy) {
    throw new Error(
      `symmetria: unknown dialect "${name}"; call registerDialect() before binding a driver`,
    );
  }

  return strategy;
};

/** The name a binding carries for a driver's dialect; strategies register themselves. */
export const dialectName = (
  dialect: Dialect | DialectStrategy | undefined,
): Dialect | undefined => {
  if (dialect === undefined || typeof dialect === "string") {
    return dialect;
  }

  registerDialect(dialect);

  return registered.get(dialect)!.name;
};

export const planStrategy = (
  plan: SelectPlan | MutationPlan,
): DialectStrategy => resolveDialect(planDialect(plan));
