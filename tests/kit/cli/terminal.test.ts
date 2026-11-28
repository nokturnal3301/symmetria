import { expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { schema, int } from "../../../packages/runtime/src";
import { withMigrationDirectory } from "../../support/directories";

/**
 * Runs a command in a pseudo-terminal of the given size, types the keys one
 * by one and returns the exit code and everything it drew.
 */
const type = async (
  argumentsList: readonly string[],
  size: { cols: number; rows: number },
  keys: readonly string[],
  cwd = process.cwd(),
) => {
  let output = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("packages/kit/src/cli/index.ts"),
      ...argumentsList,
    ],
    {
      cwd,
      env: { ...process.env, DATABASE_URL: "", TERM: "xterm-256color" },
      terminal: {
        ...size,
        data: (_terminal, data) => {
          output += decoder.decode(data, { stream: true });
        },
      },
    },
  );
  await Bun.sleep(800);

  for (const key of keys) {
    child.terminal!.write(key);
    // readline waits 500 ms after a lone Esc for the rest of a sequence.
    await Bun.sleep(key === "\u001b" ? 650 : 100);
  }

  const exitCode = await Promise.race([
    child.exited,
    Bun.sleep(5000).then(() => "running"),
  ]);

  if (exitCode === "running") {
    child.kill("SIGKILL");
  }

  return { exitCode, output };
};

/** The schema browser over the example schema. */
const browse = (
  size: { cols: number; rows: number },
  keys: readonly string[],
) =>
  type(
    ["inspect", "--config", resolve("examples/symmetria.config.ts")],
    size,
    keys,
  );

/** The rows the browser draws, each addressed as `ESC [row;1H ESC [2K text`. */
const drawnLines = (output: string): string[] =>
  [...output.matchAll(/\u001b\[\d+;1H\u001b\[2K(.*?)(?=\u001b\[\d+;1H|$)/gs)]
    .map((match) => stripVTControlCharacters(match[1]!))
    .filter(Boolean);

for (const size of [
  { cols: 100, rows: 30 },
  { cols: 40, rows: 14 },
  { cols: 24, rows: 9 },
]) {
  test(`the schema browser draws within ${size.cols}x${size.rows}, navigates and q restores the terminal`, async () => {
    const { exitCode, output } = await browse(size, [
      "\u001b[B",
      "\r",
      "\u001b[C",
      "\u001b[C",
      "\u001b[C",
      "\u001b[C",
      "\u001b[6~",
      "/",
      "id",
      "\r",
      "\u001b",
      "q",
    ]);

    expect(exitCode).toBe(0);
    const lines = drawnLines(output);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(size.cols);
    }

    // Leaves the alternate screen with the cursor visible.
    expect(output.lastIndexOf("\u001b[?1049l")).toBeGreaterThan(
      output.lastIndexOf("\u001b[?1049h"),
    );
    expect(output.lastIndexOf("\u001b[?25h")).toBeGreaterThan(
      output.lastIndexOf("\u001b[?25l"),
    );
  }, 15000);
}

test("Ctrl-C in the schema browser exits with 130 and restores the terminal", async () => {
  // Also from a search, where other keys are text.
  for (const keys of [["\u0003"], ["/", "id", "\u0003"]]) {
    const { exitCode, output } = await browse({ cols: 100, rows: 30 }, keys);

    expect(exitCode).toBe(130);
    expect(output.lastIndexOf("\u001b[?1049l")).toBeGreaterThan(
      output.lastIndexOf("\u001b[?1049h"),
    );
    expect(output.lastIndexOf("\u001b[?25h")).toBeGreaterThan(
      output.lastIndexOf("\u001b[?25l"),
    );
  }

  // Ctrl-D still closes it like q.
  expect((await browse({ cols: 100, rows: 30 }, ["\u0004"])).exitCode).toBe(0);
}, 30000);

test(
  "Escape closes a typed question; the keys of an arrow do not",
  () =>
    withMigrationDirectory(async (directory) => {
      await writeFile(
        join(directory, "symmetria.config.ts"),
        `export default ${JSON.stringify({ schema: schema({ records: { id: int } }).$snapshot(), directory: "migrations" })};`,
      );
      const size = { cols: 100, rows: 30 };

      // The name question of generate, left unanswered.
      const closed = await type(
        ["generate"],
        size,
        ["abc", "\u001b"],
        directory,
      );
      expect(closed.exitCode).toBe(1);
      expect(stripVTControlCharacters(closed.output)).toContain(
        "symmetria: generate requires a migration name",
      );
      expect(await readdir(directory)).toEqual(["symmetria.config.ts"]);

      // An arrow starts with the same byte and only moves the cursor.
      const named = await type(
        ["generate"],
        size,
        ["initia", "\u001b[D", "\u001b[C", "l", "\r"],
        directory,
      );
      expect(named.exitCode).toBe(0);
      expect(await readdir(join(directory, "migrations"))).toContain(
        "000001_initial",
      );
    }),
  30000,
);

test(
  "the dashboard says that the migrations directory does not exist, as status does",
  () =>
    withMigrationDirectory(async (directory) => {
      const size = { cols: 100, rows: 30 };
      const screen = async (...argumentsList: string[]) => {
        const { exitCode, output } = await type(
          ["--no-animation", ...argumentsList],
          size,
          ["\u001b"],
          directory,
        );

        expect(exitCode).toBe(0);

        // One line, as the header may wrap the note.
        return stripVTControlCharacters(output).replace(/\s+/g, " ");
      };

      // No config file and no ./migrations: the wrong place, not an empty chain.
      const lost = await screen();
      expect(lost).toContain(
        "No config file was found in the current directory",
      );
      expect(lost).toContain("No directory");
      expect(lost).not.toContain("0 local");

      // A project before its first generate.
      await writeFile(
        join(directory, "symmetria.config.ts"),
        'export default { directory: "migrations" };',
      );
      const fresh = await screen();
      expect(fresh).toContain("No migrations yet: the migrations directory");
      expect(fresh).not.toContain("0 local");
      expect(await screen("--dir", "migratoins")).toContain(
        "(--dir) does not exist",
      );

      // With the directory there, the header counts what it holds.
      await mkdir(join(directory, "migrations"));
      const empty = await screen();
      expect(empty).toContain("0 local");
      expect(empty).not.toContain("No directory");
    }),
  30000,
);

test("diff and inspect --no-interactive keep their colours on a terminal; piped output stays plain", async () => {
  const run = async (argumentsList: string[], terminal: boolean) => {
    let output = "";
    const decoder = new TextDecoder();
    const { NO_COLOR: _noColor, ...environment } = process.env;
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("packages/kit/src/cli/index.ts"),
        ...argumentsList,
        "--config",
        resolve("examples/symmetria.config.ts"),
        "--dir",
        resolve(".build/terminal-test-empty-migrations"),
      ],
      terminal
        ? {
            env: { ...environment, DATABASE_URL: "", TERM: "xterm-256color" },
            terminal: {
              cols: 100,
              rows: 30,
              data: (_terminal, data) => {
                output += decoder.decode(data, { stream: true });
              },
            },
          }
        : {
            env: { ...environment, DATABASE_URL: "" },
            stdout: "pipe",
          },
    );

    if (!terminal) {
      output = await new Response(child.stdout as ReadableStream).text();
    }

    await child.exited;

    return output;
  };

  for (const command of [["diff"], ["inspect", "--no-interactive"]]) {
    const shown = await run(command, true);
    // The palette's 24-bit colours, as 3.5.0 wrote them.
    expect(shown).toMatch(/\u001b\[(?:1;)?38;2;\d+;\d+;\d+m/);
    expect(await run(command, false)).not.toContain("\u001b[");
  }
}, 15000);
