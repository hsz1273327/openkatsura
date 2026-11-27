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

vi.mock('../../settings/tabs/bridge/BridgeAgentRow', () => ({
  BridgeAgentRow: () => <div data-testid="bridge-agent-row" />,
}));

function bridgeState(overrides: Record<string, unknown> = {}) {
  return {
    status: {
      platforms: [
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
      ],
      qq: { appID: 'qq-app', hasAppSecret: true, enabled: true, status: 'connected' },
      'synology-chat': { incomingUrl: 'https://nas.local/chat', hasBotToken: true, enabled: false, status: 'disconnected' },
      permissionMode: 'auto',
      readOnly: false,
      receiptEnabled: true,
      richStreamingEnabled: true,
      knownUsers: {},
      owner: {},
    },
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

describe('BridgeTab dynamic schema credential custody', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useSettingsStore.setState({
      settingsSnapshot: { status: 'idle', key: null, data: null, error: null, requestId: 0, updatedAt: null },
    });
  });

  it('tests stored secrets for both QQ and arbitrary Synology Chat plugins across Bridge tabs without sending masked values', () => {
    const testPlatform = vi.fn();
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ testPlatform }) as never);

    render(<BridgeTab />);

    fireEvent.click(screen.getByRole('button', { name: 'QQ: settings.bridge.test' }));
    expect(testPlatform).toHaveBeenCalledWith('qq', { appID: 'qq-app' }, true);

    fireEvent.click(screen.getByRole('tab', { name: 'Synology Chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Synology Chat: settings.bridge.test' }));
    expect(testPlatform).toHaveBeenCalledWith('synology-chat', { incomingUrl: 'https://nas.local/chat' }, true);
  });

  it('sends dirty plaintext secrets directly and disables saved-credential lookup', () => {
    const testPlatform = vi.fn();
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ testPlatform }) as never);

    render(<BridgeTab />);

    fireEvent.click(screen.getByRole('tab', { name: 'Synology Chat' }));
    const secretInput = screen.getByLabelText('Bot Token') as HTMLInputElement;
    expect(secretInput.placeholder).toBe('settings.bridge.secretStoredPlaceholder');
    expect(secretInput.value).toBe('');

    fireEvent.change(secretInput, { target: { value: 'fresh-nas-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Synology Chat: settings.bridge.test' }));

    expect(testPlatform).toHaveBeenCalledWith(
      'synology-chat',
      { incomingUrl: 'https://nas.local/chat', botToken: 'fresh-nas-token' },
      false,
    );
  });

  it('saves updated fields on blur without overwriting untouched stored secrets', () => {
    const saveBridgeConfig = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useBridgeState).mockReturnValue(bridgeState({ saveBridgeConfig }) as never);

    render(<BridgeTab />);

    fireEvent.click(screen.getByRole('tab', { name: 'Synology Chat' }));
    const urlInput = screen.getByLabelText('Incoming URL') as HTMLInputElement;
    fireEvent.change(urlInput, { target: { value: 'https://nas.local/chat-v2' } });
    fireEvent.blur(urlInput);

    expect(saveBridgeConfig).toHaveBeenCalledWith(
      'synology-chat',
      { incomingUrl: 'https://nas.local/chat-v2' },
      undefined,
    );
  });

  it('prevents enabling a plugin when required fields are missing', () => {
    const showToast = vi.fn();
    const saveBridgeConfig = vi.fn();
    const state = bridgeState({ showToast, saveBridgeConfig });
    (state.status as Record<string, unknown>)['synology-chat'] = { incomingUrl: '', hasBotToken: false, enabled: false };
    vi.mocked(useBridgeState).mockReturnValue(state as never);

    render(<BridgeTab />);

    fireEvent.click(screen.getByRole('tab', { name: 'Synology Chat' }));
    const toggle = screen.getByRole('switch', { name: 'Synology Chat: settings.bridge.connectionToggle' });
    fireEvent.click(toggle);

    expect(showToast).toHaveBeenCalledWith('settings.bridge.noCredentials', 'error');
    expect(saveBridgeConfig).not.toHaveBeenCalled();
  });

  it('hides guest AGENTS.public.md when allowGuests is off and reveals it when allowGuests is enabled', () => {
    const saveBridgeConfig = vi.fn().mockResolvedValue(undefined);
    const state = bridgeState({ saveBridgeConfig });
    vi.mocked(useBridgeState).mockReturnValue(state as never);

    const { rerender } = render(<BridgeTab />);

    expect(screen.queryByText('settings.agent.publicAgentsMd')).toBeNull();

    const guestToggle = screen.getByRole('switch', { name: 'QQ: settings.bridge.allowGuests' });
    fireEvent.click(guestToggle);
    expect(saveBridgeConfig).toHaveBeenCalledWith('qq', null, undefined, { allowGuests: true });

    const enabledState = bridgeState({ saveBridgeConfig });
    (enabledState.status as Record<string, unknown>).qq = {
      appID: 'qq-app',
      hasAppSecret: true,
      enabled: true,
      allowGuests: true,
      status: 'connected',
    };
    vi.mocked(useBridgeState).mockReturnValue(enabledState as never);
    rerender(<BridgeTab />);

    expect(screen.getByText('settings.agent.publicAgentsMd')).toBeTruthy();
  });
});
