import { msg, mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type { ServerLowDiskSpace } from "@t3tools/contracts";

const GIGABYTE = 1024 ** 3;

function formatGigabytes(bytes: number): string {
  const gigabytes = bytes / GIGABYTE;
  return `${gigabytes < 10 ? gigabytes.toFixed(1) : Math.round(gigabytes)} GB`;
}

/** Shared wording for the low-disk warning so web and mobile say the same thing. */
export function describeLowDiskSpace(
  report: ServerLowDiskSpace,
  resolve: MFunctionType = mFallback,
): string {
  const percent = Math.max(0, Math.floor((report.availableBytes / report.totalBytes) * 100));
  return resolve(
    msg("{free} free ({percent}%) on {path}. T3 Code stops working when the disk fills.", {
      free: formatGigabytes(report.availableBytes),
      percent,
      path: report.path,
    }),
  );
}
