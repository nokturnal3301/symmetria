import { createDatabase, type QueryProfiler } from "symmetria";
import { postgres } from "symmetria/bun";
import { appSchema } from "./schema";

/** Some examples compile SQL offline, so the URL is only required when connecting. */
export const connect = (profiler?: QueryProfiler) => {
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "Set DATABASE_URL, then run the migrations and seed commands in examples/README.md.",
    );
  }

  return createDatabase({
    schema: appSchema,
    driver: postgres({ url, max: 4, ...(profiler ? { profiler } : {}) }),
  });
};
