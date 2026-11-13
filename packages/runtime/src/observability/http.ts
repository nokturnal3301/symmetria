import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Small, portable HTTP listener for the opt-in profiler. */
export const serveProfiler = async (options: {
  hostname: string;
  port: number;
  fetch: (request: Request, server: { port: number }) => Promise<Response>;
}) => {
  let port = options.port;
  const hostname = options.hostname.includes(":")
    ? `[${options.hostname}]`
    : options.hostname;

  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();

      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }

      // The request target is an origin-form path; resolving it against the
      // base would read "//x" as another host, so it is appended instead.
      const target = incoming.url ?? "/";
      const request = new Request(
        new URL(
          `http://${hostname}:${port}${target.startsWith("/") ? target : `/${target}`}`,
        ).href,
        {
          method: incoming.method ?? "GET",
          headers,
        },
      );
      const response = await options.fetch(request, { port });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500);
      outgoing.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;

  return Object.freeze({
    port,
    url: new URL(`http://${hostname}:${port}`),
    stop: (force = false) =>
      (closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));

        if (force) {
          server.closeAllConnections();
        }
      })),
  });
};
