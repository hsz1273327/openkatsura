import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// On Windows under Electron 42's bundled Node.js runtime, recursive `fs.rmSync`
// on `os.tmpdir()` paths containing 8.3 short names (`RUNNER~1`) frequently fails
// with `ENOTEMPTY` / `EPERM` on `\\?\C:\Users\RUNNER~1\...`.
// Normalize to the native long path first, apply retry defaults, and for
// `force: true` temp-dir cleanup fall back to best-effort entry removal so
// Windows NTFS delete-pending delays never fail passing tests.
if (process.platform === "win32") {
  const TRANSIENT_RM_CODES = new Set(["EPERM", "ENOTEMPTY", "EBUSY"]);
  const tmpRoots = new Set<string>();
  const rawTmp = os.tmpdir();
  tmpRoots.add(path.resolve(rawTmp).toLowerCase());
  try {
    tmpRoots.add(path.resolve(fs.realpathSync.native(rawTmp)).toLowerCase());
  } catch {}

  const isInsideTmpDir = (targetPath: string): boolean => {
    const normalized = path.resolve(targetPath).toLowerCase();
    for (const root of tmpRoots) {
      if (normalized.startsWith(root + path.sep)) return true;
    }
    return false;
  };

  const resolveLongPath = (target: fs.PathLike): string | null => {
    const raw = typeof target === "string" ? target : target instanceof URL ? target.pathname : String(target);
    try {
      return fs.realpathSync.native(raw);
    } catch {
      return raw;
    }
  };

  const bestEffortDrainSync = (dirPath: string): void => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          bestEffortDrainSync(full);
          try { fs.rmdirSync(full); } catch {}
        } else {
          try { fs.chmodSync(full, 0o666); } catch {}
          try { fs.unlinkSync(full); } catch {}
        }
      }
      try { fs.rmdirSync(dirPath); } catch {}
    } catch {}
  };

  const origRmSync = fs.rmSync.bind(fs);
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    if (!options?.recursive) {
      return origRmSync(target, options);
    }
    const resolvedTarget = resolveLongPath(target) ?? target;
    const opts: fs.RmOptions = options.maxRetries === undefined
      ? { maxRetries: 10, retryDelay: 50, ...options }
      : options;
    try {
      return origRmSync(resolvedTarget, opts);
    } catch (err: any) {
      if (
        options.force
        && TRANSIENT_RM_CODES.has(err?.code)
        && typeof resolvedTarget === "string"
        && isInsideTmpDir(resolvedTarget)
      ) {
        bestEffortDrainSync(resolvedTarget);
        return;
      }
      throw err;
    }
  }) as typeof fs.rmSync;

  const origRmAsync = fsp.rm.bind(fsp);
  fsp.rm = (async (target: fs.PathLike, options?: fs.RmOptions) => {
    if (!options?.recursive) {
      return origRmAsync(target, options);
    }
    const resolvedTarget = resolveLongPath(target) ?? target;
    const opts: fs.RmOptions = options.maxRetries === undefined
      ? { maxRetries: 10, retryDelay: 50, ...options }
      : options;
    try {
      return await origRmAsync(resolvedTarget, opts);
    } catch (err: any) {
      if (
        options.force
        && TRANSIENT_RM_CODES.has(err?.code)
        && typeof resolvedTarget === "string"
        && isInsideTmpDir(resolvedTarget)
      ) {
        bestEffortDrainSync(resolvedTarget);
        return;
      }
      throw err;
    }
  }) as typeof fsp.rm;
}
