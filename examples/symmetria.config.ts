import { defineMigrationConfig } from "symmetria-kit";
import { appSchema } from "./schema";

export default defineMigrationConfig({
  schema: appSchema,
  directory: "../.symmetria-examples/migrations",
  databaseUrl: process.env.DATABASE_URL,
  metadataSchema: process.env.SYMMETRIA_EXAMPLE_SCHEMA ?? "public",
});
