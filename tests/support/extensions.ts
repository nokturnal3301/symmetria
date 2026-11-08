import { postgres } from "./postgres";

const rowsOf = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);

/**
 * Whether the test server can provide an extension. When it can, the extension is
 * installed into `public` once so suites that put `public` on their search_path see it.
 */
export const hasExtension = async (
  url: string | undefined,
  name: string,
): Promise<boolean> => {
  if (!url) {
    return false;
  }

  const driver = postgres({ url, max: 1 });

  try {
    const available = rowsOf(
      await driver.execute({
        sql: "SELECT 1 AS present FROM pg_available_extensions WHERE name = $1",
        parameters: [name],
      }),
    );

    if (!available.length) {
      console.log(`[tests] extension "${name}" is unavailable; skipping`);

      return false;
    }

    await driver.execute({
      sql: `CREATE EXTENSION IF NOT EXISTS "${name}" SCHEMA public`,
      parameters: [],
    });

    return true;
  } finally {
    await driver.close();
  }
};
