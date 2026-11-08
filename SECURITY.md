# Security policy

## Supported versions

Only the latest published minor version of `symmetria` and `symmetria-kit`
receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
vulnerability reporting on the repository ("Security" → "Report a
vulnerability") or email the maintainer listed in `package.json`. Include the
affected package and version, a minimal reproduction and the impact you expect.

You will get an acknowledgement within a few days. Confirmed problems are fixed
in a patch release and described in the changelog once the fix is published.

## Scope notes

- The runtime binds every value as a query parameter and quotes identifiers. Raw
  `sql` template literals embed only the template's literal text; values
  interpolated into them are parameters as well.
- The profiler HTTP listener binds to loopback only, checks `Host`, `Origin` and
  `Sec-Fetch-Site`, and requires the per-server token for every request. It
  still exposes SQL text and bound parameters to anything that holds the token,
  so treat the token like a credential and keep the listener out of production
  builds.
- Migration `verify` creates and drops databases on the server given by
  `--verify-url`; never point it at an application database.
