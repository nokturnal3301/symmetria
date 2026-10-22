import { stringWidth } from "bun";

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

export const formatError = (message: string, color = false): string => {
  if (!color) {
    return message;
  }

  const { style } = theme(color);

  return `\n  ${style("✕", "danger")} ${message
    .split("\n")
    .map((line) => style(line, "danger"))
    .join("\n    ")}\n`;
};

export const wrapLines = (text: string, width = terminalWidth()): string[] => {
  const lines: string[] = [];
  let activeStyle = "";

  for (const original of text.split("\n")) {
    let line = activeStyle;
    let length = 0;

    for (const part of original
      .replace(/[\r\t]/g, " ")
      .split(/(\u001b\[[\d;]*m)/)) {
      if (part.startsWith("\u001b[")) {
        line += part;
        activeStyle = part === "\u001b[0m" ? "" : activeStyle + part;
        continue;
      }

      for (const { segment } of graphemes.segment(part)) {
        const size = stringWidth(segment);

        if (length + size > width && length) {
          lines.push(line + (activeStyle ? "\u001b[0m" : ""));
          line = activeStyle;
          length = 0;
        }

        line += segment;
        length += size;
      }
    }

    lines.push(line + (activeStyle ? "\u001b[0m" : ""));
  }

  return lines;
};
