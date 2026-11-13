import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

/**
 * Runs the schema browser in a pseudo-terminal of the given size, types the
 * keys one by one and returns the exit code and everything it drew.
 */
const browse = async (
  size: { cols: number; rows: number },
  keys: readonly string[],
) => {
  let output = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn(
    [
      process.execPath,
      resolve("packages/kit/src/cli/index.ts"),
      "inspect",
      "--config",
      resolve("examples/symmetria.config.ts"),
    ],
    {
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
