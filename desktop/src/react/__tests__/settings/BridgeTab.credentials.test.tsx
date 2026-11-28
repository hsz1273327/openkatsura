// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeTab } from '../../settings/tabs/BridgeTab';
import { useBridgeState } from '../../settings/tabs/bridge/useBridgeState';
import { useSettingsStore } from '../../settings/store';

vi.mock('../../settings/helpers', () => ({
  t: (key: string) => key,
}));

vi.mock('../../settings/tabs/bridge/useBridgeState', () => ({
  useBridgeState: vi.fn(),
}));

const PLATFORMS = [
  {
    id: 'qq',
    displayName: 'QQ',
    description: 'QQ Bot',
    configSchema: [
      { key: 'appID', label: 'AppID', type: 'string', required: true },
      { key: 'appSecret', label: 'AppSecret', type: 'secret', required: true },
    ],
  },
  {
    id: 'synology-chat',
    displayName: 'Synology Chat',
    description: 'Synology Chat Incoming/Outgoing Webhook',
    configSchema: [
      { key: 'incomingUrl', label: 'Incoming URL', type: 'string', required: true },
      { key: 'botToken', label: 'Bot Token', type: 'secret', required: true },
    ],
  },
];

function bridgeState(overrides: Record<string, unknown> = {}) {
  return {
    status: {
      platforms: PLATFORMS,
      permissionMode: 'auto',
      readOnly: false,
      receiptEnabled: true,
      richStreamingEnabled: true,
      knownUsers: {},
      owner: {},
    },
    workstationPlatforms: PLATFORMS,
    workstations: [
      {
        id: 'ws_qq_1',
        name: 'Personal QQ',
        platform: 'qq',
        agentId: 'hana',
        appID: 'qq-app',
        hasAppSecret: true,
        enabled: true,
        allowGuests: false,
        owner: null,
        status: 'connected',
        knownUsers: [],
      },
      {
        id: 'ws_syno_1',
        name: 'NAS Chat',
        platform: 'synology-chat',
        agentId: 'katsura',
        incomingUrl: 'https://nas.local/chat',
        hasBotToken: true,
        enabled: false,
        allowGuests: false,
        owner: null,
        status: 'disconnected',
        knownUsers: [],
      },
    ],
    testingWorkstationId: null,
    createWorkstation: vi.fn().mockResolvedValue(null),
    updateWorkstation: vi.fn().mockResolvedValue(null),
    deleteWorkstation: vi.fn().mockResolvedValue(true),
    testWorkstation: vi.fn().mockResolvedValue(undefined),
    globalSettingsSaving: false,
    selectedAgentId: 'hana',
    setSelectedAgentId: vi.fn(),
    publicAgentsMd: '',
    setPublicAgentsMd: vi.fn(),
    savePublicAgentsMd: vi.fn(),
    saveBridgeConfig: vi.fn().mockResolvedValue(undefined),
    testPlatform: vi.fn().mockResolvedValue(undefined),
    testingPlatform: null,
    showToast: vi.fn(),
    setOwner: vi.fn(),
    loadStatus: vi.fn(),
    saveGlobalSettings: vi.fn(),
    ...overrides,
  };
}

describe('BridgeTab workstation tabs & credential custody', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      agents: [
        { id: 'hana', name: 'Hana', yuan: 'hanako', isPrimary: true },
        { id: 'katsura', name: 'Katsura', yuan: 'katsura', isPrimary: false },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useSettingsStore.setState({
      agents: [],
      settingsSnapshot: { status: 'idle', key: null, data: null, error: null, requestId: 0, updatedAt: null },
    });
  });

  it('tests stored secrets per workstation tab without sending masked values and shows fixed binding', () => {
    const testWorkstation = vi.fn();
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ testWorkstation }) as never);

    render(<BridgeTab />);

    expect(screen.getByText('settings.bridge.workstationPlatform: QQ')).toBeTruthy();
    expect(screen.getByText('settings.bridge.targetAgent: Hana')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Personal QQ: settings.bridge.test' }));
    expect(testWorkstation).toHaveBeenCalledWith('ws_qq_1', { appID: 'qq-app' }, true);

    fireEvent.click(screen.getByRole('tab', { name: 'NAS Chat' }));
    expect(screen.getByText('settings.bridge.workstationPlatform: Synology Chat')).toBeTruthy();
    expect(screen.getByText('settings.bridge.targetAgent: Katsura')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'NAS Chat: settings.bridge.test' }));
    expect(testWorkstation).toHaveBeenCalledWith('ws_syno_1', { incomingUrl: 'https://nas.local/chat' }, true);
  });

  it('sends dirty plaintext secrets directly and disables saved-credential lookup', () => {
    const testWorkstation = vi.fn();
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ testWorkstation }) as never);

    render(<BridgeTab />);

    fireEvent.click(screen.getByRole('tab', { name: 'NAS Chat' }));
    const secretInput = screen.getByLabelText('Bot Token') as HTMLInputElement;
    expect(secretInput.placeholder).toBe('settings.bridge.secretStoredPlaceholder');
    expect(secretInput.value).toBe('');

    fireEvent.change(secretInput, { target: { value: 'fresh-nas-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'NAS Chat: settings.bridge.test' }));

    expect(testWorkstation).toHaveBeenCalledWith(
      'ws_syno_1',
      { incomingUrl: 'https://nas.local/chat', botToken: 'fresh-nas-token' },
      false,
    );
  });

  it('saves updated fields on blur without overwriting untouched stored secrets', () => {
    const updateWorkstation = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ updateWorkstation }) as never);

    render(<BridgeTab />);

    fireEvent.click(screen.getByRole('tab', { name: 'NAS Chat' }));
    const urlInput = screen.getByLabelText('Incoming URL') as HTMLInputElement;
    fireEvent.change(urlInput, { target: { value: 'https://nas.local/chat-v2' } });
    fireEvent.blur(urlInput);

    expect(updateWorkstation).toHaveBeenCalledWith('ws_syno_1', {
      credentials: { incomingUrl: 'https://nas.local/chat-v2' },
    });
  });

  it('prevents enabling a workstation when required fields are missing', () => {
    const showToast = vi.fn();
    const updateWorkstation = vi.fn();
    const state = bridgeState({ showToast, updateWorkstation });
    (state.workstations as Record<string, unknown>[])[1] = {
      id: 'ws_syno_1',
      name: 'NAS Chat',
      platform: 'synology-chat',
      agentId: 'katsura',
      incomingUrl: '',
      hasBotToken: false,
      enabled: false,
      allowGuests: false,
      owner: null,
    };
    vi.mocked(useBridgeState).mockReturnValue(state as never);

    render(<BridgeTab />);

    fireEvent.click(screen.getByRole('tab', { name: 'NAS Chat' }));
    const toggle = screen.getByRole('switch', { name: 'NAS Chat: settings.bridge.connectionToggle' });
    fireEvent.click(toggle);

    expect(showToast).toHaveBeenCalledWith('settings.bridge.noCredentials', 'error');
    expect(updateWorkstation).not.toHaveBeenCalled();
  });

  it('hides guest AGENTS.public.md when allowGuests is off and reveals it directly below the toggle when enabled', () => {
    const updateWorkstation = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ updateWorkstation }) as never);

    const { rerender } = render(<BridgeTab />);

    expect(screen.queryByText('settings.agent.publicAgentsMd')).toBeNull();

    const guestToggle = screen.getByRole('switch', { name: 'Personal QQ: settings.bridge.allowGuests' });
    fireEvent.click(guestToggle);
    expect(updateWorkstation).toHaveBeenCalledWith('ws_qq_1', { allowGuests: true });

    const enabledState = bridgeState({ updateWorkstation });
    (enabledState.workstations as Record<string, unknown>[])[0].allowGuests = true;
    vi.mocked(useBridgeState).mockReturnValue(enabledState as never);
    rerender(<BridgeTab />);

    expect(screen.getByText('settings.agent.publicAgentsMd')).toBeTruthy();
  });

  it('allows creating a new workstation with explicit platform and target agent and deleting an existing one', () => {
    const createWorkstation = vi.fn().mockResolvedValue({
      id: 'ws_qq_2',
      name: 'Work QQ',
      platform: 'qq',
      agentId: 'katsura',
      enabled: false,
      allowGuests: false,
      owner: null,
    });
    const deleteWorkstation = vi.fn().mockResolvedValue(true);
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ createWorkstation, deleteWorkstation }) as never);

    render(<BridgeTab />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.bridge.deleteWorkstation' }));
    expect(deleteWorkstation).toHaveBeenCalledWith('ws_qq_1');

    fireEvent.click(screen.getByRole('button', { name: '+ settings.bridge.addWorkstation' }));
    fireEvent.change(screen.getByLabelText('settings.bridge.workstationName'), {
      target: { value: 'Work QQ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.bridge.createWorkstation' }));

    expect(createWorkstation).toHaveBeenCalledWith({
      platform: 'qq',
      agentId: 'hana',
      name: 'Work QQ',
    });
  });
});
