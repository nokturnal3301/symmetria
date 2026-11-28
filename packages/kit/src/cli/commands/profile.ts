import {
  profileScreen,
  profilerEndpoint,
  profilerHttpError,
} from "../screens/profiler";
import type { CliContext } from "../context";

/** How long the profiler may take to answer the one request of a run without a terminal. */
const PROFILE_TIMEOUT_MS = 10000;

/**
 * The profiler's requests, read once. The limit covers the whole answer: a
 * server that accepts the connection and never answers, or sends its headers
 * and then stops, would hold the command for good.
 */
export const profiledRequests = async (
  address: string,
  token: string,
  limit = PROFILE_TIMEOUT_MS,
): Promise<unknown> => {
  const requests = profilerEndpoint(address, "requests");
  const unanswered = (error: unknown): never => {
    throw error instanceof Error && error.name === "TimeoutError"
      ? new Error(
          `symmetria: the profiler at ${requests.origin} did not answer within ${limit}ms; check --profile-url and that the application called profiler.serve()`,
        )
      : error;
  };
  const response = await fetch(requests, {
    headers: { "x-symmetria-token": token },
    signal: AbortSignal.timeout(limit),
  }).catch(unanswered);

  if (!response.ok) {
    throw new Error(profilerHttpError(response.status));
  }

  return response.json().catch(unanswered);
};

/** `profile`: the live profiler screen, or its JSON feed when not interactive. */
export const profile = async (context: CliContext): Promise<void> => {
  const { values, interactive, color, output } = context;
  const address = values["profile-url"] ?? "http://127.0.0.1:7331";
  const token = values["profile-token"] ?? process.env.SYMMETRIA_PROFILE_TOKEN;

  if (!token) {
    throw new Error(
      "symmetria: profile requires --profile-token or SYMMETRIA_PROFILE_TOKEN, the token configured for or returned by profiler.serve()",
    );
  }

  // Checked before the screen opens.
  profilerEndpoint(address, "requests");

  if (interactive) {
    return profileScreen(address, token, color);
  }

  output(
    JSON.stringify(
      { requests: await profiledRequests(address, token) },
      null,
      2,
    ),
  );
};
