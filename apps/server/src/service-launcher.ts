import { main } from "./serviceLauncher.ts";

// OpenRC and pre-archive service installations invoke this file directly.
main().catch((cause: unknown) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  process.stderr.write(`[service-launcher] ${error.message}\n`);
  process.exitCode = 1;
});
