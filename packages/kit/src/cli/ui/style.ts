/**
 * Terminal styling primitives: colour detection, theme, width fitting, panels, headings, errors and wrapping.
 */
import stringWidth from "string-width";
import { stripVTControlCharacters } from "node:util";

export const supportsColor = (): boolean =>
  !!process.stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";

const brandGradient = [
  [137, 180, 250],
  [190, 160, 255],
  [245, 168, 216],
] as const;

const palette = {
  accent: `38;2;${brandGradient[0].join(";")}`,
  violet: `38;2;${brandGradient[1].join(";")}`,
  pink: `38;2;${brandGradient[2].join(";")}`,
  connected: "38;2;126;226;168",
  success: "38;2;158;195;255",
  warning: "38;2;232;180;250",
  danger: "38;2;255;126;171",
  muted: "38;2;163;170;202",
  border: "38;2;95;100;154",
  text: "38;2;217;222;247",
  strong: "1;38;2;217;222;247",
  selected: "1;38;2;245;220;255;48;2;65;55;100",
} as const;

export const theme = (enabled = supportsColor()) => {
  const style = (text: string, tone: keyof typeof palette): string =>
    enabled ? `\u001b[${palette[tone]}m${text}\u001b[0m` : text;

  return {
    style,
    brand: (frame = -10) =>
      style("◇", "accent") +
      " " +
      [..."symmetria"]
        .map((letter, position) => {
          if (!enabled) {
            return letter;
          }

          const progress = position / 4;
          const segment = Math.min(1, Math.floor(progress));
          const highlightPosition = 4 - 6 * Math.cos((frame * Math.PI) / 32);
          const highlight =
            frame < 0
              ? 0
              : 0.85 * Math.exp(-((position - highlightPosition) ** 2) / 3);
          const channels = brandGradient[segment]!.map(
            (channel, channelIndex) => {
              const interpolated =
                channel +
                (brandGradient[segment + 1]![channelIndex]! - channel) *
                  (progress - segment);

              return Math.round(
                interpolated + (255 - interpolated) * highlight,
              );
            },
          );

          return `\u001b[38;2;${channels.join(";")}m${letter}\u001b[0m`;
        })
        .join(""),
  };
};

export const terminalWidth = (): number =>
  Math.max(1, Math.min(process.stdout.columns || 88, 96) - 4);

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Keep ANSI styling and wide characters intact while clipping a single terminal line. */
export const fitLine = (text: string, width = terminalWidth()): string => {
  text = text.replace(/[\r\n\t]/g, " ");

  if (width <= 0) {
    return "";
  }

  if (stringWidth(text) <= width) {
    return text;
  }

  let result = "";
  let length = 0;

  for (const part of text.split(/(\u001b\[[\d;]*m)/)) {
    if (part.startsWith("\u001b[")) {
      result += part;
      continue;
    }

    for (const { segment } of graphemes.segment(part)) {
      const size = stringWidth(segment);

      if (length + size > width - 1) {
        return `${result}…${text.includes("\u001b[") ? "\u001b[0m" : ""}`;
      }

      result += segment;
      length += size;
    }
  }

  return result;
};

export const panel = (lines: readonly string[], color = false): string => {
  const { style } = theme(color);
  const width = terminalWidth();

  if (width < 12) {
    return lines.map((line) => `  ${fitLine(line, width)}`).join("\n");
  }

  return [
    `  ${style(`╭${"─".repeat(width - 2)}╮`, "border")}`,
    ...lines.map((line) => {
      const content = fitLine(line, width - 4);

      return `  ${style("│", "border")} ${content}${" ".repeat(width - 4 - stringWidth(content))} ${style("│", "border")}`;
    }),
    `  ${style(`╰${"─".repeat(width - 2)}╯`, "border")}`,
  ].join("\n");
};

export const heading = (
  title: string,
  subtitle: string,
  color = false,
): string => {
  const { style } = theme(color);

  return `\n  ${style("◇", "accent")} ${style(title, "strong")}${subtitle ? `  ${style(subtitle, "muted")}` : ""}\n`;
};

/**
 * Escape sequences as a terminal reads them (ECMA-48): CSI with any
 * parameters (`ESC[38:5:196m` too), the string sequences OSC, DCS, SOS, PM and
 * APC up to their terminator, and the two-character ones; 7- and 8-bit.
 */
const ESCAPE_SEQUENCE =
  /(?:\u001b\[|\u009b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c)|\u001b[\x20-\x2f]*[\x30-\x7e]/g;

/**
 * Control characters other than line breaks and tabs, and the bidirectional
 * overrides and isolates (U+202A–U+202E, U+2066–U+2069) that make a terminal
 * show text in another order than it is.
 */
const CONTROL_CHARACTER =
  /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Text from outside the CLI (PostgreSQL errors and DETAIL, SQL, stored
 * values, names read from a database) made safe for a terminal: escape
 * sequences, control characters and bidirectional overrides removed, line
 * breaks and tabs kept.
 */
export const terminalText = (text: string): string =>
  text.replace(ESCAPE_SEQUENCE, "").replace(CONTROL_CHARACTER, "");

/**
 * The colour sequences theme() writes: a reset, the palette (24-bit
 * foreground, bold, the selected row's background) and the logo's 24-bit
 * letters. No other attribute (conceal, blink, reverse) and no cursor or
 * screen sequence.
 */
const OWN_COLOUR = new RegExp(
  `(\u001b\\[(?:0|38;2;\\d{1,3};\\d{1,3};\\d{1,3}|${Object.values(palette).join("|")})m)`,
);

/**
 * Command output for a terminal: the colours the CLI adds stay, every other
 * escape sequence and control character goes (see terminalText). Commands
 * also filter the names they read from a database before colouring them, so
 * a name cannot bring a colour of its own either.
 */
export const terminalOutput = (text: string): string =>
  text
    .split(OWN_COLOUR)
    .map((part, index) => (index % 2 ? part : terminalText(part)))
    .join("");

/** An error for stderr; its text can quote values from the database, so it is filtered. */
export const formatError = (message: string, color = false): string => {
  message = terminalText(message);

  if (!color) {
    return message;
  }

  const { style } = theme(color);

  return `\n  ${style("✕", "danger")} ${message
    .split("\n")
    .map((line) => style(line, "danger"))
    .join("\n    ")}\n`;
};

/**
 * Wraps text to the width, keeping ANSI styling across the rows. A row breaks
 * after a space or a `/` when its last third has one, so a path or a sentence
 * is not cut inside a word; otherwise, and always with `words` off, it breaks
 * at the width.
 */
export const wrapLines = (
  text: string,
  width = terminalWidth(),
  words = true,
): string[] => {
  const lines: string[] = [];
  let activeStyle = "";

  for (const original of text.split("\n")) {
    // The row so far: its graphemes, each with the style codes written right
    // before it and the style in effect after them.
    let cells: { text: string; size: number; codes: string; style: string }[] =
      [];
    let rowStyle = activeStyle;
    let codes = "";
    let length = 0;

    const row = (count: number): string =>
      rowStyle +
      cells
        .slice(0, count)
        .map((cell) => cell.codes + cell.text)
        .join("");

    for (const part of original
      .replace(/[\r\t]/g, " ")
      .split(/(\u001b\[[\d;]*m)/)) {
      if (part.startsWith("\u001b[")) {
        codes += part;
        activeStyle = part === "\u001b[0m" ? "" : activeStyle + part;
        continue;
      }

      for (const { segment } of graphemes.segment(part)) {
        const size = stringWidth(segment);

        if (length + size > width && length) {
          let end = cells.length;
          let kept = length;

          for (let position = cells.length - 1; position > 0; position--) {
            if (!words || kept * 3 < width * 2) {
              break;
            }

            if (/^[ /]$/.test(cells[position]!.text)) {
              end = position + 1;
              break;
            }

            kept -= cells[position]!.size;
          }

          const last = cells[end - 1]!;
          lines.push(row(end) + (last.style ? "\u001b[0m" : ""));
          rowStyle = last.style;
          cells = cells.slice(end);
          length = cells.reduce((sum, cell) => sum + cell.size, 0);
        }

        cells.push({ text: segment, size, codes, style: activeStyle });
        codes = "";
        length += size;
      }
    }

    lines.push(row(cells.length) + codes + (activeStyle ? "\u001b[0m" : ""));
  }

  return lines;
};

/**
 * Wraps highlighted code with a line-number gutter. Numbers follow the source
 * lines: the rows a long line wraps onto get an empty gutter.
 */
export const numberedLines = (
  code: string,
  width: number,
  gutter: (label: string) => string,
): string[] => {
  const labels = stripVTControlCharacters(code)
    .split("\n")
    .flatMap((line, index) =>
      wrapLines(line, width).map((_row, part) =>
        part ? "" : String(index + 1),
      ),
    );

  return wrapLines(code, width).map(
    (row, index) => `${gutter((labels[index] ?? "").padStart(3))}  ${row}`,
  );
};
