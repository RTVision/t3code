import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { ReactElement } from "react";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  grants: new Set<string>(),
  reconcile: vi.fn(),
  query: vi.fn(),
  updateAtom: Symbol("update"),
}));
vi.hoisted(() => {
  Object.assign(globalThis, {
    window: {
      location: {
        origin: "http://localhost",
        href: "http://localhost/settings",
        hostname: "localhost",
      },
    },
  });
});
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness: hooks } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
    useEffect: () => undefined,
  };
});
vi.mock("react/compiler-runtime", async () => ({
  c: (await import("../../test/reactHookHarness")).reactHookHarness.useMemoCache,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === state.updateAtom ? { status: "idle" } : []),
}));
vi.mock("../../state/server", async (original) => ({
  ...(await original<typeof import("../../state/server")>()),
  primaryServerKeybindingsAtom: "keys",
  serverEnvironment: { updateStateAtom: () => state.updateAtom },
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => ({
    environmentId: "primary",
    label: "Primary",
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: null,
  }),
  usePrimaryEnvironmentId: () => "primary",
  useRelayEnvironmentDiscovery: () => ({ environments: new Map() }),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  readEnvironmentScope: (_id: unknown, grant: string) => state.grants.has(grant),
  useEnvironmentScope: (_id: unknown, grant: string) => state.grants.has(grant),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    state.query(atom);
    return { data: null, error: null, isPending: false, refresh: vi.fn() };
  },
}));
vi.mock("../../environments/primary", async (original) => ({
  ...(await original<typeof import("../../environments/primary")>()),
  usePrimarySessionState: () => ({ data: null }),
  isLoopbackHostname: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../uiStateStore", () => ({
  useUiStateStore: (select: (state: unknown) => unknown) =>
    select({ defaultAdvertisedEndpointKey: null, setDefaultAdvertisedEndpointKey: vi.fn() }),
}));
vi.mock("../../cloud/publicConfig", async (original) => ({
  ...(await original<typeof import("../../cloud/publicConfig")>()),
  hasCloudPublicConfig: () => true,
}));
vi.mock("../../localEnvironment", () => ({ isLocalEnvironmentDisabled: () => false }));
vi.mock("../../cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => ({
    isSignedIn: true,
    linkState: { data: {}, error: null, isPending: false },
    managedTunnelActive: false,
    publishAgentActivity: false,
    holdWebhooksWhileOffline: false,
    reconcileCloudState: state.reconcile,
  }),
}));
import { ConnectionsSettings } from "./ConnectionsSettings";

function callComponent(element: ReactElement<Record<string, unknown>>) {
  hooks.reset();
  hooks.beginRender();
  return (
    element.type as (props: Record<string, unknown>) => ReactElement<Record<string, unknown>>
  )(element.props);
}
function renderPanel() {
  hooks.beginRender();
  return ConnectionsSettings();
}
function relayControl() {
  const row = visitElements(
    renderPanel(),
    (el) => typeof el.type === "function" && el.type.name === "CloudLinkRow",
  );
  if (!row) return null;
  const configured = callComponent(row);
  const controls = callComponent(configured);
  return visitElements(
    controls,
    (el) => el.props.ariaLabel === "Publish agent activity to mobile clients",
  );
}
beforeEach(() => {
  hooks.reset();
  state.grants = new Set();
  state.reconcile.mockReset().mockResolvedValue(true);
  state.query.mockClear();
});

it("allows relay-only sessions to publish activity without maintaining the environment", async () => {
  state.grants = new Set(["relay:read", "relay:write"]);
  const control = relayControl();
  if (!control) throw new Error("Missing relay control");
  expect(control.props.disabled).toBe(false);
  await (control.props.onCheckedChange as (value: boolean) => Promise<void>)(true);
  expect(state.reconcile).toHaveBeenCalledWith({ managedTunnel: false, publish: true });
  expect(state.query.mock.calls.every(([atom]) => atom === null)).toBe(true);
});
it("keeps relay read-only controls visible and rejects a queued mutation", async () => {
  state.grants = new Set(["relay:read"]);
  const control = relayControl();
  if (!control) throw new Error("Missing relay control");
  expect(control.props.disabled).toBe(true);
  await (control.props.onCheckedChange as (value: boolean) => Promise<void>)(true);
  expect(state.reconcile).not.toHaveBeenCalled();
});
it("hides relay controls when neither relay grant is present", () => {
  expect(
    visitElements(
      renderPanel(),
      (el) => typeof el.type === "function" && el.type.name === "CloudLinkRow",
    ),
  ).toBeNull();
});
it("rechecks relay write access when a previously allowed handler runs", async () => {
  state.grants = new Set(["relay:read", "relay:write"]);
  const control = relayControl();
  if (!control) throw new Error("Missing relay control");
  state.grants.delete("relay:write");
  await (control.props.onCheckedChange as (value: boolean) => Promise<void>)(true);
  expect(state.reconcile).not.toHaveBeenCalled();
});

it("keeps desktop network and WSL queries behind maintenance permission", () => {
  Object.assign(window, { desktopBridge: {} });
  try {
    state.grants = new Set(["relay:read", "relay:write"]);
    renderPanel();
    expect(state.query.mock.calls.every(([atom]) => atom === null)).toBe(true);
    state.query.mockClear();
    state.grants.add("environment:maintain");
    renderPanel();
    expect(state.query.mock.calls.filter(([atom]) => atom !== null)).toHaveLength(2);
  } finally {
    delete window.desktopBridge;
  }
});
