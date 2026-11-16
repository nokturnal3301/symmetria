import { setTimeout as delay } from "node:timers/promises";
import { createDatabase, createProfiler, sql } from "symmetria";
import { postgres } from "symmetria/bun";
import { createSchemaSQL } from "symmetria-kit";
import { appSchema } from "./schema";
import { recentPosts } from "./queries";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "Set DATABASE_URL to a local PostgreSQL database for this demo.",
  );
}

const namespace = `symmetria_profile_${crypto.randomUUID().replaceAll("-", "")}`;
const connectionUrl = new URL(databaseUrl);
connectionUrl.searchParams.set(
  "options",
  `-c search_path=${namespace} -c timezone=UTC`,
);
const administrator = postgres({ url: databaseUrl, max: 1 });
const profiler = createProfiler({ capacity: 200 });
const db = createDatabase({
  schema: appSchema,
  driver: postgres({ url: connectionUrl.toString(), max: 4, profiler }),
});
const shutdown = new AbortController();
let created = false;
let profilingServer: Awaited<ReturnType<typeof profiler.serve>> | undefined;
let applicationServer: Bun.Server<undefined> | undefined;

const stop = () => shutdown.abort();

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await administrator.execute({
    sql: `CREATE SCHEMA "${namespace}"`,
    parameters: [],
  });
  created = true;
  await administrator.execute({
    sql: `SET search_path TO "${namespace}"`,
    parameters: [],
  });

  for (const statement of createSchemaSQL(appSchema.$snapshot())) {
    await administrator.execute(statement);
  }

  const setup = createDatabase({ schema: appSchema, driver: administrator });
  const users = await setup.users
    .insert(
      Array.from({ length: 20 }, (_, position) => ({
        email: `user${position + 1}@profile.test`,
        name: `Author ${position + 1}`,
      })),
    )
    .returning("id");
  await setup.posts.insert(
    Array.from({ length: 200 }, (_, position) => ({
      slug: `profile-post-${position + 1}`,
      title: `Post ${position + 1}`,
      authorId: users[position % users.length]!.id,
      state: "published" as const,
      views: 9007199254740993n + BigInt(position),
    })),
  );

  const handleRequest = profiler.fetch(async (request) => {
    const path = new URL(request.url).pathname;

    if (path === "/feed") {
      await recentPosts(db)({ limit: 20 });
    } else if (path === "/authors/nested") {
      await db.users(
        (user) => ({
          name: user.name,
          posts: user.posts(
            (post) => ({
              title: post.title,
              views: post.views,
            }),
            { orderBy: (post) => post.id.descending, limit: 3 },
          ),
        }),
        { orderBy: (user) => user.id.ascending, limit: 5 },
      );
    } else if (path === "/authors/n-plus-one") {
      const authors = await db.users(
        (user) => ({
          id: user.id,
          name: user.name,
        }),
        { orderBy: (user) => user.id.ascending, limit: 5 },
      );

      // Deliberate N+1: the profiler marks repeated SQL with ↻.
      for (const author of authors) {
        await db.posts(
          (post) => ({
            title: post.title,
            views: post.views,
          }),
          {
            where: (post) => post.authorId.is(author.id),
            orderBy: (post) => post.id.descending,
            limit: 3,
          },
        );
      }
    } else if (path === "/slow") {
      // Artificial database delay, visible in Database rather than Build/Decode.
      await db.users(
        (user) => ({
          id: user.id,
          delay: sql<string>`pg_sleep(${0.08})`,
        }),
        { limit: 1 },
      );
    } else if (path === "/error") {
      // Deliberate unique-constraint violation; the INSERT stores no row.
      await db.users.insert({ email: "user1@profile.test", name: "Duplicate" });
    } else {
      return new Response("Not found", { status: 404 });
    }

    return new Response("OK");
  });

  profilingServer = await profiler.serve({
    port: Number(process.env.PROFILE_PORT ?? 7331),
  });
  applicationServer = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.DEMO_PORT ?? 7332),
    fetch: async (request) => {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === "/stop"
      ) {
        stop();

        return new Response("Stopping profiler demo\n");
      }

      try {
        return await handleRequest(request);
      } catch (error) {
        // Catch outside the profiled handler so the request itself retains ERROR.
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    },
  });
  console.log(`Profiler: ${profilingServer.url}`);
  console.log(`Application: ${applicationServer.url}`);
  console.log(
    `Open: bun packages/kit/src/cli/index.ts profile --profile-url ${profilingServer.url} --profile-token ${profilingServer.token}`,
  );
  console.log(
    `Stop: Ctrl+C or curl -X POST ${new URL("/stop", applicationServer.url)}`,
  );
  console.log(`PID: ${process.pid}; isolated schema: ${namespace}`);

  while (!shutdown.signal.aborted) {
    await Promise.all(
      [
        "/feed",
        "/authors/nested",
        "/authors/n-plus-one",
        "/slow",
        "/error",
      ].map(async (path) => {
        const response = await fetch(new URL(path, applicationServer!.url));
        await response.text();

        if (response.status !== (path === "/error" ? 500 : 200)) {
          throw new Error(`Demo request ${path} returned ${response.status}`);
        }
      }),
    );

    try {
      await delay(1200, undefined, { signal: shutdown.signal });
    } catch (error) {
      if (!shutdown.signal.aborted) {
        throw error;
      }
    }
  }
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await applicationServer?.stop();
  await profilingServer?.stop();
  await db.$close();

  try {
    if (created) {
      await administrator.execute({
        sql: `DROP SCHEMA "${namespace}" CASCADE`,
        parameters: [],
      });
    }
  } finally {
    await administrator.close();
  }
}
