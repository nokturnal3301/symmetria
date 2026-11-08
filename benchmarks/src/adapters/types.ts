export type InsertRow = { slug: string; title: string; authorId: number };
export type Statement = { sql: string; parameters: readonly unknown[] };
export type Observer = (statement: Statement) => void;

/** Every library implements the same scenarios against the same tables. */
export type Bench = {
  readonly name: string;
  readonly pointLookup: (id: number) => PromiseLike<unknown>;
  readonly listJoin: () => PromiseLike<unknown>;
  readonly nested: (offset: number) => PromiseLike<unknown>;
  /** Same nested shape, but paginated by `users.id > afterId` instead of OFFSET. */
  readonly nestedKeyset: (afterId: number) => PromiseLike<unknown>;
  readonly insertOne: (row: InsertRow) => PromiseLike<unknown>;
  readonly insertMany: (rows: InsertRow[]) => PromiseLike<unknown>;
  readonly updateViews: (id: number) => PromiseLike<unknown>;
  /** Compile the nested query to SQL without executing it, when the library can. */
  readonly buildNested?: (offset: number) => Statement;
  readonly close: () => Promise<void>;
};
