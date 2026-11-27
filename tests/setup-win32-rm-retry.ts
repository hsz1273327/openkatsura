import fs from "node:fs";
import fsp from "node:fs/promises";

// On Windows under Electron's bundled Node.js runtime, recursive temp-directory
// cleanup in test afterEach hooks (`fs.rmSync(tmpDir, { recursive: true, force: true })`)
// frequently hits transient ENOTEMPTY/EPERM/EBUSY errors when maxRetries defaults to 0.
// Provide sensible retry defaults for recursive removals on win32 without altering
// non-recursive or non-Windows semantics.
if (process.platform === "win32") {
  const origRmSync = fs.rmSync.bind(fs);
  fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions) => {
    if (options?.recursive && options.maxRetries === undefined) {
      return origRmSync(target, { maxRetries: 10, retryDelay: 100, ...options });
    }
    return origRmSync(target, options);
  }) as typeof fs.rmSync;

  const origRmAsync = fsp.rm.bind(fsp);
  fsp.rm = ((target: fs.PathLike, options?: fs.RmOptions) => {
    if (options?.recursive && options.maxRetries === undefined) {
      return origRmAsync(target, { maxRetries: 10, retryDelay: 100, ...options });
    }
    return origRmAsync(target, options);
  }) as typeof fsp.rm;
}
