const TIMESTAMP_TYPE =
  /^(timestamptz|timestamp)(?:\s*\(\s*(\d)\s*\))?(?:\s+with(out)?\s+time\s+zone)?$/;
const TIMESTAMP_TEXT =
  /^(\d{4})-(\d\d)-(\d\d)[t ](\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?\s*(z|[+-]\d\d(?::?\d\d)?)?$/;
const POSTGRES_EPOCH = 946_684_800_000_000n;

/** The microsecond a column stores; leave session-dependent or unknown spellings to PostgreSQL. */
export const timestampKey = (
  text: string,
  type: string,
): string | undefined => {
  const column = TIMESTAMP_TYPE.exec(type);
  const parts = column && TIMESTAMP_TEXT.exec(text.trim().toLowerCase());
  if (!column || !parts || Number(column[2] ?? 6) > 6) {
    return undefined;
  }

  const zoned = column[1] === "timestamptz" || /with\s+time/.test(type);
  const zone = parts[8];
  if (zoned && !zone) {
    return undefined;
  }

  // Without time zone, PostgreSQL ignores an offset even when one is given.
  const offset =
    zoned && zone !== "z"
      ? (zone![0] === "-" ? -1 : 1) *
        (Number(zone!.slice(1, 3)) * 60 +
          (zone!.length > 3 ? Number(zone!.slice(-2)) : 0))
      : 0;
  // Date.UTC would turn years 1..99 into 1901..1999.
  const date = new Date(0);
  date.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  // Do not silently normalize invalid dates, or interpret year zero as 1 BC.
  if (
    !Number(parts[1]) ||
    date.getUTCDate() !== Number(parts[3]) ||
    date.getUTCMonth() + 1 !== Number(parts[2]) ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59
  ) {
    return undefined;
  }
  date.setUTCHours(Number(parts[4]), Number(parts[5]), Number(parts[6]), 0);
  const micros =
    BigInt(date.getTime() - offset * 60_000) * 1000n +
    BigInt((parts[7] ?? "").padEnd(6, "0"));
  const unit = 10n ** BigInt(6 - Number(column[2] ?? 6));
  // Typmod precision rounds half away from PostgreSQL's epoch, not from 1970.
  const since = micros - POSTGRES_EPOCH;
  const rounded =
    since >= 0n
      ? ((since + unit / 2n) / unit) * unit
      : -(((-since + unit / 2n) / unit) * unit);
  return `timestamp:${rounded}`;
};
