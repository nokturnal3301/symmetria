import {
  profileScreen,
  profilerEndpoint,
  profilerHttpError,
} from "../screens/profiler";
import type { CliContext } from "../context";

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
  const requests = profilerEndpoint(address, "requests");

  if (interactive) {
    return profileScreen(address, token, color);
  }

  const response = await fetch(requests, {
    headers: { "x-symmetria-token": token },
  });

  if (!response.ok) {
    throw new Error(profilerHttpError(response.status));
  }

  output(JSON.stringify({ requests: await response.json() }, null, 2));
};
