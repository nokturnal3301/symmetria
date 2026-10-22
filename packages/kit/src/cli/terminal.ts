import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import {
  fitLine,
  supportsColor,
  terminalWidth,
  theme,
  wrapLines,
} from "./style";

export type Choose = (
  question: string,
  choices: readonly string[],
) => Promise<number | undefined>;

type ChoiceOptions = {
  color?: boolean;
  descriptions?: readonly string[];
  header?: (frame: number) => string;
  animation?: boolean;
};

export const choose = (
  question: string,
  choices: readonly string[],
  options: ChoiceOptions = {},
): Promise<number | undefined> =>
  new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("symmetria: interactive selection requires a terminal");
    }

    if (!choices.length) {
      return resolve(undefined);
    }

    const { style } = theme(options.color ?? supportsColor());
    let selected = 0;
    let renderedLines = 0;
    let finished = false;
    let headerHeight = 0;
    let headerLines: string[] = [];
    let frame = 0;
    const wasRaw = process.stdin.isRaw;
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(`${options.header ? "" : "\n"}\u001b[?25l`);

    const draw = () => {
      // Leave room for the title, description and keyboard hint on short terminals.
      const visibleCount = Math.min(
        choices.length,
        Math.max(1, (process.stdout.rows || 24) - headerHeight - 8),
      );
      const start = Math.min(
        Math.max(0, selected - visibleCount + 1),
        choices.length - visibleCount,
      );
      const width = terminalWidth();
      const lines = [
        `  ${style(fitLine(question, width), "strong")}`,
        "",
        ...choices
          .slice(start, start + visibleCount)
          .map((choice, position) => {
            const index = start + position;
            const label = fitLine(
              `${index === selected ? "›" : " "} ${index + 1}  ${choice}`,
              width,
            );

            return `  ${style(label, index === selected ? "selected" : "text")}`;
          }),
        "",
        ...(options.descriptions
          ? [
              `  ${style(fitLine(options.descriptions[selected] ?? "", width), "pink")}`,
            ]
          : []),
        `  ${style(fitLine("↑ ↓ navigate  ·  enter select  ·  esc exit", width), "muted")}`,
      ];
      const cursor = options.header
        ? `\u001b[${headerHeight + 2};1H`
        : renderedLines
          ? `\u001b[${renderedLines}A\r`
          : "";
      renderedLines = lines.length;
      process.stdout.write(
        cursor +
          lines.map((line) => `\u001b[2K${line}`).join("\n") +
          "\n\u001b[J",
      );
    };

    const resize = () => {
      if (options.header) {
        headerLines = options
          .header(frame)
          .split("\n")
          .slice(0, Math.max(1, (process.stdout.rows || 24) - 9));
        headerHeight = headerLines.length;
        process.stdout.write("\u001b[H\u001b[2J" + headerLines.join("\n"));
        renderedLines = 0;
      }

      draw();
    };

    const finish = (choice?: number) => {
      if (finished) {
        return;
      }

      finished = true;

      if (animationTimer) {
        clearInterval(animationTimer);
      }

      process.stdin.off("keypress", keypress);
      process.stdin.off("end", end);
      process.stdout.off("resize", resize);
      process.off("SIGTERM", terminate);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write(
        `${options.header ? `\u001b[${headerHeight + 2};1H` : `\u001b[${renderedLines}A\r`}\u001b[J\u001b[?25h`,
      );
      process.stdout.write(
        `  ${style(choice === undefined ? "○" : "◆", "accent")} ${choice === undefined ? style("Closed", "muted") : choices[choice]}\n\n`,
      );
      resolve(choice);
    };

    const end = () => finish();

    const terminate = () => {
      finish();
      process.exit(143);
    };

    const keypress = (
      input: string,
      key: { name?: string; ctrl?: boolean },
    ) => {
      if (
        key.name === "escape" ||
        (key.ctrl && ["c", "d"].includes(key.name ?? ""))
      ) {
        return finish();
      }

      if (key.name === "return") {
        return finish(selected);
      }

      if (key.name === "up") {
        selected = (selected + choices.length - 1) % choices.length;
      } else if (key.name === "down" || key.name === "tab") {
        selected = (selected + 1) % choices.length;
      } else if (key.name === "home") {
        selected = 0;
      } else if (key.name === "end") {
        selected = choices.length - 1;
      } else if (/^[1-9]$/.test(input) && Number(input) <= choices.length) {
        return finish(Number(input) - 1);
      } else {
        return;
      }

      draw();
    };

    process.stdin.on("keypress", keypress);
    process.stdin.once("end", end);
    process.stdout.on("resize", resize);
    process.once("SIGTERM", terminate);
    const animationTimer =
      options.header && options.animation && (options.color ?? supportsColor())
        ? setInterval(() => {
            const next = options.header!(++frame)
              .split("\n")
              .slice(0, headerHeight);
            const updates = next.flatMap((line, position) =>
              line === headerLines[position]
                ? []
                : [`\u001b[${position + 1};1H\u001b[2K${line}`],
            );

            if (updates.length) {
              process.stdout.write(`\u001b[s${updates.join("")}\u001b[u`);
            }

            headerLines = next;
          }, 50)
        : undefined;
    resize();
  });

/** Keep the dashboard in one terminal screen and restore the shell on every exit. */
export const withScreen = async (
  operation: () => Promise<void>,
): Promise<void> => {
  const wasRaw = process.stdin.isRaw;
  let restored = false;

  const restore = () => {
    if (restored) {
      return;
    }

    restored = true;

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw);
    }

    process.stdout.write("\u001b[0m\u001b[?25h\u001b[?1049l");
  };

  const interrupt = () => process.exit(130);

  const terminate = () => process.exit(143);

  process.once("exit", restore);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  process.stdout.write("\u001b[?1049h\u001b[H\u001b[2J");

  try {
    await operation();
  } finally {
    process.off("exit", restore);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    restore();
  }
};

/** A scrollable action result in the dashboard's existing screen. */
export const view = (
  title: string,
  content: string,
  color: boolean,
): Promise<void> =>
  new Promise((resolve) => {
    const { style, brand } = theme(color);
    const wasRaw = process.stdin.isRaw;
    let offset = 0;
    let lines: string[] = [];
    let pageSize = 1;
    let finished = false;

    const draw = () => {
      pageSize = Math.max(1, (process.stdout.rows || 24) - 5);
      lines = wrapLines(content);
      offset = Math.min(offset, Math.max(0, lines.length - pageSize));
      const page = lines.slice(offset, offset + pageSize);
      const footer = `↑ ↓ scroll · enter / esc back${lines.length > pageSize ? ` · ${offset + 1}–${offset + page.length}/${lines.length}` : ""}`;
      process.stdout.write(
        [
          "\u001b[H\u001b[2J",
          `  ${brand()} ${style(`/ ${title}`, "muted")}\n\n`,
          page.join("\n"),
          `\u001b[${Math.max(1, (process.stdout.rows || 24) - 1)};1H  ${style(fitLine(footer), "muted")}`,
        ].join(""),
      );
    };

    const finish = () => {
      if (finished) {
        return;
      }

      finished = true;
      process.stdin.off("keypress", keypress);
      process.stdin.off("end", finish);
      process.stdout.off("resize", draw);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write("\u001b[?25h");
      resolve();
    };

    const keypress = (
      _input: string,
      key: { name?: string; ctrl?: boolean },
    ) => {
      if (
        ["escape", "return"].includes(key.name ?? "") ||
        (key.ctrl && key.name === "c")
      ) {
        return finish();
      }

      if (key.name === "up") {
        offset = Math.max(0, offset - 1);
      } else if (key.name === "down") {
        offset++;
      } else if (key.name === "pageup") {
        offset = Math.max(0, offset - pageSize);
      } else if (key.name === "pagedown" || key.name === "space") {
        offset += pageSize;
      } else if (key.name === "home") {
        offset = 0;
      } else if (key.name === "end") {
        offset = lines.length;
      } else {
        return;
      }

      draw();
    };

    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", keypress);
    process.stdin.once("end", finish);
    process.stdout.on("resize", draw);
    process.stdout.write("\u001b[?25l");
    draw();
  });

export const ask = async (
  question: string,
  color = supportsColor(),
): Promise<string> => {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const { style } = theme(color);

  try {
    return (
      await terminal.question(
        `  ${style("◆", "violet")} ${style(question, "strong")} `,
      )
    ).trim();
  } finally {
    terminal.close();
  }
};

/** Animate only real work, then erase the transient line before printing its result. */
export const withSpinner = async <Result>(
  label: string,
  operation: () => Promise<Result>,
  options: { enabled: boolean; color: boolean; animation: boolean },
): Promise<Result> => {
  if (
    !options.enabled ||
    !process.stdout.isTTY ||
    process.env.TERM === "dumb"
  ) {
    return operation();
  }

  const { style } = theme(options.color);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const started = performance.now();
  let frame = 0;

  const draw = () => {
    const elapsed = `${((performance.now() - started) / 1000).toFixed(1)}s`;
    const line = `${style(options.animation ? frames[frame++ % frames.length]! : "◇", frame % 8 < 4 ? "accent" : "violet")} ${label}  ${style(elapsed, "muted")}`;
    process.stdout.write(`\r\u001b[2K  ${fitLine(line)}`);
  };

  const restore = () => process.stdout.write("\r\u001b[2K\u001b[?25h");

  const interrupt = () => {
    restore();
    process.exit(130);
  };

  const terminate = () => {
    restore();
    process.exit(143);
  };

  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  process.stdout.write("\u001b[?25l");
  draw();
  const timer = options.animation ? setInterval(draw, 80) : undefined;

  try {
    return await operation();
  } finally {
    if (timer) {
      clearInterval(timer);
    }

    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    restore();
  }
};
