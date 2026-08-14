import { resolve } from 'node:path';

/**
 * Where the built PWA lives, as an absolute path — or `''` when static serving
 * is switched off.
 *
 * `WEB_ROOT` is read in three places that do not agree about relative paths.
 * `express.static` resolves one against the process working directory and
 * happily serves assets; `existsSync` does the same and reports the directory is
 * there; `res.sendFile` refuses a relative path outright and throws. A relative
 * `WEB_ROOT` therefore produced a server that served every asset and 500'd every
 * page navigation, with a clean boot log and a passing healthcheck, because the
 * healthcheck only touches `/api/health`.
 *
 * Resolving once here is what makes the three agree. It happens at load, against
 * the working directory the process started in, so nothing later — a `chdir`, a
 * differently-invoked npm script — can move the app shell out from under a
 * running server.
 */
export function resolveWebRoot(raw: string | undefined, cwd: string = process.cwd()): string {
  // Whitespace-only counts as unset: a dashboard that stores `WEB_ROOT: " "`
  // means "off", and resolving it would silently point static serving at cwd.
  const value = (raw ?? '').trim();
  if (!value) return '';
  // resolve() returns an absolute path unchanged and normalises the rest,
  // including any trailing slash, so join(webRoot, 'index.html') is predictable.
  return resolve(cwd, value);
}
