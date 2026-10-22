import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../.cache/prisma/client";
import { DATABASE_URL, POOL_SIZE } from "../config";
import type { Bench, Observer } from "./types";

export const create = (
  strategy: "join" | "query",
  observe?: Observer,
): Bench => {
  const adapter = new PrismaPg({
    connectionString: DATABASE_URL,
    max: POOL_SIZE,
  });
  const prisma = new PrismaClient({
    adapter,
    log: observe ? [{ emit: "event", level: "query" }] : [],
  });

  if (observe) {
    prisma.$on("query", (event) =>
      observe({ sql: event.query, parameters: JSON.parse(event.params) }),
    );
  }

  const bench: Bench & {
    nested: (offset: number, afterId?: number) => PromiseLike<unknown>;
  } = {
    name: `Prisma (${strategy})`,
    pointLookup: (id) =>
      prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, name: true },
      }),
    listJoin: () =>
      prisma.post.findMany({
        select: { id: true, title: true, author: { select: { name: true } } },
        where: { state: "published" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
        relationLoadStrategy: strategy,
      }),
    nested: (offset, afterId?: number) =>
      prisma.user.findMany({
        skip: afterId === undefined ? offset : 0,
        where: afterId === undefined ? {} : { id: { gt: afterId } },
        select: {
          id: true,
          name: true,
          posts: {
            select: {
              title: true,
              views: true,
              tags: { select: { tag: { select: { label: true } } } },
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 3,
          },
        },
        orderBy: { id: "asc" },
        take: 50,
        relationLoadStrategy: strategy,
      }),
    nestedKeyset: (afterId) => bench.nested(0, afterId),
    insertOne: (row) =>
      prisma.post.create({
        data: { slug: row.slug, title: row.title, authorId: row.authorId },
        select: { id: true },
      }),
    insertMany: (rows) => prisma.post.createMany({ data: rows }),
    updateViews: (id) =>
      prisma.post.update({
        where: { id },
        data: { views: { increment: 1 } },
        select: { views: true },
      }),
    close: () => prisma.$disconnect(),
  };

  return bench;
};
