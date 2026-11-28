// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeTab } from '../../settings/tabs/BridgeTab';
import { useBridgeState } from '../../settings/tabs/bridge/useBridgeState';
import { useSettingsStore } from '../../settings/store';

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../../settings/tabs/bridge/useBridgeState', () => ({
  useBridgeState: vi.fn(),
}));

vi.mock('../../settings/tabs/bridge/PlatformSection', () => ({
  PlatformSection: ({ platform }: { platform: string }) => <div data-testid={`platform-${platform}`} />,
}));

function bridgeState(overrides: Record<string, unknown> = {}) {
  const platforms = [
    { id: 'qq', displayName: 'QQ', configSchema: [] },
    { id: 'synology-chat', displayName: 'Synology Chat', configSchema: [] },
  ];
  return {
    status: {
      platforms,
      permissionMode: 'auto',
      readOnly: false,
      receiptEnabled: true,
      richStreamingEnabled: true,
      knownUsers: {},
      owner: {},
    },
    workstationPlatforms: platforms,
    workstations: [
      {
        id: 'ws_synology_1',
        name: 'Synology Station',
        platform: 'synology-chat',
        agentId: 'hana',
        enabled: false,
        allowGuests: false,
        owner: null,
        status: 'disconnected',
      },
      {
        id: 'ws_qq_1',
        name: 'QQ Station',
        platform: 'qq',
        agentId: 'hana',
        enabled: false,
        allowGuests: false,
        owner: null,
        status: 'disconnected',
      },
    ],
    testingWorkstationId: null,
    createWorkstation: vi.fn(),
    updateWorkstation: vi.fn(),
    deleteWorkstation: vi.fn(),
    testWorkstation: vi.fn(),
    globalSettingsSaving: false,
    selectedAgentId: 'hana',
    setSelectedAgentId: vi.fn(),
    publicAgentsMd: '',
    setPublicAgentsMd: vi.fn(),
    savePublicAgentsMd: vi.fn(),
    saveBridgeConfig: vi.fn(),
    testPlatform: vi.fn(),
    testingPlatform: null,
    showToast: vi.fn(),
    setOwner: vi.fn(),
    loadStatus: vi.fn(),
    saveGlobalSettings: vi.fn(),
    ...overrides,
  };
}

describe('BridgeTab permission mode and dynamic plugin rendering', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useSettingsStore.setState({
      settingsSnapshot: { status: 'idle', key: null, data: null, error: null, requestId: 0, updatedAt: null },
    });
  });

  it('renders bridge permission mode as a three-option select without ask mode', () => {
    const saveGlobalSettings = vi.fn();
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ saveGlobalSettings }) as never);

    render(<BridgeTab />);

    const trigger = screen.getByRole('button', { name: /settings\.bridge\.permissionModeAuto/ });
    fireEvent.click(trigger);

    expect(screen.getByRole('option', { name: 'settings.bridge.permissionModeReadOnly' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'settings.bridge.permissionModeAuto' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'settings.bridge.permissionModeOperate' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /ask/i })).toBeNull();

    fireEvent.click(screen.getByRole('option', { name: 'settings.bridge.permissionModeOperate' }));
    expect(saveGlobalSettings).toHaveBeenCalledWith({ permissionMode: 'operate' });
  });

  it('saves the bridge receipt toggle through global bridge settings', () => {
    const saveGlobalSettings = vi.fn();
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ saveGlobalSettings }) as never);

    render(<BridgeTab />);

    const toggle = screen.getByRole('switch', { name: 'settings.bridge.receiptEnabled' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);
    expect(saveGlobalSettings).toHaveBeenCalledWith({ receiptEnabled: false });
  });

  it('saves the rich streaming toggle through global bridge settings', () => {
    const saveGlobalSettings = vi.fn();
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ saveGlobalSettings }) as never);

    render(<BridgeTab />);

    const toggle = screen.getByRole('switch', { name: 'settings.bridge.richStreamingEnabled' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);
    expect(saveGlobalSettings).toHaveBeenCalledWith({ richStreamingEnabled: false });
  });

  it('keeps bridge permission mode in loading state until backend truth arrives', () => {
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ status: null }) as never);

    render(<BridgeTab />);

    const trigger = screen.getByRole('button', { name: /common\.loading/ }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /settings\.bridge\.permissionModeAuto/ })).toBeNull();
  });

  it('renders empty-state guidance when no bridge plugins are registered', () => {
    const state = bridgeState({ workstationPlatforms: [] });
    (state.status as { platforms: unknown[] }).platforms = [];
    vi.mocked(useBridgeState).mockReturnValue(state as never);

    render(<BridgeTab />);

    expect(document.body.querySelectorAll('[data-testid^="platform-"]').length).toBe(0);
    expect(document.body.textContent).toContain('settings.bridge.noPluginsHint');
  });

  it('renders workstations as tabs in order without hardcoded platforms', () => {
    const state = bridgeState();
    vi.mocked(useBridgeState).mockReturnValue(state as never);

    render(<BridgeTab />);

    const tabs = Array.from(document.body.querySelectorAll('[role="tab"]'))
      .map((el) => el.getAttribute('data-bridge-workstation-tab'));
    expect(tabs).toEqual(['ws_synology_1', 'ws_qq_1']);
    expect(document.body.querySelector('[data-testid="platform-synology-chat"]')).not.toBeNull();
  });
});
