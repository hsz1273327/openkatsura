import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "os";
import { registerMockBridgeProviders } from "./helpers/register-mock-bridge-providers.ts";

const createWechatAdapter = vi.fn();

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { BridgeManager } from "../lib/bridge/bridge-manager.ts";

describe("BridgeManager platform status", () => {
  let cleanupProviders: (() => void) | null = null;

  beforeEach(() => {
    cleanupProviders = registerMockBridgeProviders({
      wechat: (...args) => createWechatAdapter(...args),
    });
  });

  afterEach(() => {
    cleanupProviders?.();
    cleanupProviders = null;
  });

  it("starts a provider with initialStatus=connecting in connecting state until ready", () => {
    createWechatAdapter.mockReset();
    createWechatAdapter.mockReturnValue({ stop: vi.fn() });

    const engine = {
      hanakoHome: os.tmpdir(),
      agent: null,
      getAgent: vi.fn(() => null),
    };
    const hub = { eventBus: { emit: vi.fn() } };
    const bm = new BridgeManager({ engine, hub });

    bm.startPlatform("wechat", { botToken: "wx-token", hanaHome: os.tmpdir() }, "hana");

    expect(bm.getStatus("hana").wechat).toMatchObject({ status: "connected", error: null });
  });
});
