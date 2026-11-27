import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeSessionManager, resolveBridgeSessionFilePath } from "../core/bridge-session-manager.ts";

const tempDirs: string[] = [];

function makeTempAgent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "katsura-bridge-pointer-"));
  tempDirs.push(root);
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  return { root, agent: { id: "katsura", sessionDir } };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Bridge channel active session pointer", () => {
  it("switches a Bridge channel pointer to any standard desktop session of the same agent while preserving metadata", () => {
    const { agent } = makeTempAgent();
    const desktopSessionA = path.join(agent.sessionDir, "desktop-a.jsonl");
    const desktopSessionB = path.join(agent.sessionDir, "desktop-b.jsonl");
    fs.writeFileSync(desktopSessionA, '{"type":"session","id":"a"}\n');
    fs.writeFileSync(desktopSessionB, '{"type":"session","id":"b"}\n');

    const bsm = new BridgeSessionManager({
      getAgentById: (id: string) => (id === agent.id ? agent : null),
    });

    // Seed existing channel binding metadata
    bsm.writeIndex({
      "qq_dm_u1@katsura": {
        file: "desktop-a.jsonl",
        platform: "qq",
        chatType: "dm",
        chatId: "u1",
        name: "Alice",
      },
    }, agent);

    expect(bsm.resolveSessionPathForSessionKey("qq_dm_u1@katsura", agent)).toBe(desktopSessionA);

    const switched = bsm.switchSessionForSessionKey({
      sessionKey: "qq_dm_u1@katsura",
      sessionPath: desktopSessionB,
      agentId: agent.id,
    });

    expect(switched).toEqual({
      ok: true,
      sessionKey: "qq_dm_u1@katsura",
      sessionPath: desktopSessionB,
      file: "desktop-b.jsonl",
    });
    expect(bsm.resolveSessionPathForSessionKey("qq_dm_u1@katsura", agent)).toBe(desktopSessionB);

    const updatedIndex = bsm.readIndex(agent);
    expect(updatedIndex["qq_dm_u1@katsura"]).toMatchObject({
      file: "desktop-b.jsonl",
      platform: "qq",
      chatType: "dm",
      chatId: "u1",
      name: "Alice",
    });
  });

  it("rejects switching outside the agent session directory or to a missing file", () => {
    const { root, agent } = makeTempAgent();
    const outsideFile = path.join(root, "escape.jsonl");
    fs.writeFileSync(outsideFile, "{}\n");

    const bsm = new BridgeSessionManager({
      getAgentById: (id: string) => (id === agent.id ? agent : null),
    });

    expect(() => bsm.switchSessionForSessionKey({
      sessionKey: "qq_dm_u1@katsura",
      sessionPath: outsideFile,
      agentId: agent.id,
    })).toThrow(/inside the agent's session directory/);

    expect(() => bsm.switchSessionForSessionKey({
      sessionKey: "qq_dm_u1@katsura",
      sessionPath: path.join(agent.sessionDir, "does-not-exist.jsonl"),
      agentId: agent.id,
    })).toThrow(/not found/);
  });

  it("resolves both unified standard session files and legacy bridge/owner files", () => {
    const { agent } = makeTempAgent();
    const unified = path.join(agent.sessionDir, "std.jsonl");
    const legacyDir = path.join(agent.sessionDir, "bridge", "owner");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = path.join(legacyDir, "old.jsonl");
    fs.writeFileSync(unified, "{}\n");
    fs.writeFileSync(legacy, "{}\n");

    expect(resolveBridgeSessionFilePath(agent.sessionDir, "std.jsonl")).toBe(unified);
    expect(resolveBridgeSessionFilePath(agent.sessionDir, "owner/old.jsonl")).toBe(legacy);
    expect(resolveBridgeSessionFilePath(agent.sessionDir, "../../etc/passwd")).toBeNull();
  });
});
