import { describeLowDiskSpace } from "@t3tools/client-runtime/low-disk-space";
import type { ServerLowDiskSpace } from "@t3tools/contracts";
import { View } from "react-native";

import { cn } from "../lib/cn";
import { AppText as Text } from "./AppText";

/** Shown above the composer while the environment's disk is nearly full. */
export function LowDiskSpaceBanner(props: {
  readonly report: ServerLowDiskSpace;
  readonly environmentLabel: string | null;
}) {
  const critical = props.report.level === "critical";
  const where = props.environmentLabel ?? "server";
  return (
    <View
      accessibilityRole="alert"
      className={cn(
        "mx-1 mb-2 rounded-2xl border px-3.5 py-2.5",
        critical ? "border-danger-border bg-danger" : "border-warning-border bg-warning",
      )}
    >
      <Text
        className={cn(
          "font-t3-medium text-sm",
          critical ? "text-danger-foreground" : "text-warning-foreground",
        )}
        numberOfLines={1}
      >
        {critical ? "Disk almost full" : "Low disk space"} on {where}
      </Text>
      <Text
        className={cn(
          "mt-0.5 text-xs",
          critical ? "text-danger-foreground" : "text-warning-foreground",
        )}
        numberOfLines={3}
      >
        {describeLowDiskSpace(props.report)}
      </Text>
    </View>
  );
}
