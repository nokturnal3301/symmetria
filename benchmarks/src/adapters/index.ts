import type { Bench, Observer } from "./types";

export const LIBRARIES = [
  "raw",
  "raw-page-first",
  "symmetria",
  "symmetria-prepared",
  "drizzle",
  "kysely",
  "prisma-join",
  "prisma-query",
] as const;
export type Library = (typeof LIBRARIES)[number];

export const load = async (
  name: Library,
  observe?: Observer,
): Promise<Bench> => {
  switch (name) {
    case "raw":
      return (await import("./raw")).create(false, observe);
    case "raw-page-first":
      return (await import("./raw")).create(true, observe);
    case "symmetria":
      return (await import("./symmetria")).create(false, observe);
    case "symmetria-prepared":
      return (await import("./symmetria")).create(true, observe);
    case "drizzle":
      return (await import("./drizzle")).create(observe);
    case "kysely":
      return (await import("./kysely")).create(observe);
    case "prisma-join":
      return (await import("./prisma")).create("join", observe);
    case "prisma-query":
      return (await import("./prisma")).create("query", observe);
  }
};
