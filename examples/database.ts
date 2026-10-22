import { createDatabase, type QueryProfiler } from "symmetria";
import { postgres } from "symmetria/driver";
import { appSchema } from "./schema";

export const connect = (profiler?: QueryProfiler) => {
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "Set DATABASE_URL, then run the migrations and seed commands in examples/README.md.",
    );
  }

  return createDatabase({
    schema: appSchema,
    driver: postgres({ url, ...(profiler ? { profiler } : {}) }),
  });
};
