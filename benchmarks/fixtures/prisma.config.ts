import { defineConfig } from "prisma/config";
import { DATABASE_URL } from "../src/config";

export default defineConfig({
  schema: "schema.prisma",
  datasource: { url: DATABASE_URL },
});
