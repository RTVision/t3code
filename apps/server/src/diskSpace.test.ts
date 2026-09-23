import { assert, it } from "@effect/vitest";

import { classifyDiskSpace, sameDiskSpaceReport } from "./diskSpace.ts";

const GB = 1024 ** 3;

it("warns below 5% free and escalates below 1%", () => {
  assert.isNull(classifyDiskSpace("/home", 10 * GB, 100 * GB));
  assert.isNull(classifyDiskSpace("/home", 5 * GB, 100 * GB));
  assert.equal(classifyDiskSpace("/home", 4.9 * GB, 100 * GB)?.level, "warning");
  assert.equal(classifyDiskSpace("/home", 1 * GB, 100 * GB)?.level, "warning");
  assert.equal(classifyDiskSpace("/home", 0.9 * GB, 100 * GB)?.level, "critical");
  assert.equal(classifyDiskSpace("/home", 0, 100 * GB)?.level, "critical");
  // Pseudo filesystems report no size and are never low.
  assert.isNull(classifyDiskSpace("/proc", 0, 0));
});

it("republishes only on a level change or a move of at least 1% of the volume", () => {
  const report = (availableBytes: number) => classifyDiskSpace("/home", availableBytes, 100 * GB);
  assert.isTrue(sameDiskSpaceReport(null, null));
  assert.isFalse(sameDiskSpaceReport(null, report(3 * GB)));
  assert.isFalse(sameDiskSpaceReport(report(3 * GB), null));
  assert.isTrue(sameDiskSpaceReport(report(3 * GB), report(2.5 * GB)));
  assert.isFalse(sameDiskSpaceReport(report(3 * GB), report(2 * GB)));
  assert.isFalse(sameDiskSpaceReport(report(1.2 * GB), report(0.9 * GB)));
});
