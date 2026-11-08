/**
 * Plan records are built immutably by construction (spreads, never assignment).
 * A real `Object.freeze` on every record costs about a third of query building,
 * so it is applied only when SYMMETRIA_FREEZE=1 (the test suite runs with it)
 * and is the identity otherwise.
 */
export const freeze: <Value>(value: Value) => Value =
  process.env.SYMMETRIA_FREEZE === "1"
    ? (value) => Object.freeze(value)
    : (value) => value;
