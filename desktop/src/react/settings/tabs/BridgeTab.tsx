import React, { useEffect, useState } from 'react';
import { t } from '../helpers';
import { PlatformSection, type CredentialField } from './bridge/PlatformSection';
import {
  useBridgeState,
  type BridgeConfigFieldDescriptor,
  type RegisteredBridgePlatform,
} from './bridge/useBridgeState';
import { BridgeAgentRow } from './bridge/BridgeAgentRow';
import { BridgePermissionModeSelect, BridgeStatusDot, type BridgePermissionMode } from './bridge/BridgeWidgets';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { Toggle } from '@/ui';
import { useSettingsStore } from '../store';
import styles from '../Settings.module.css';

interface FieldDraft {
  value: string;
  dirty: boolean;
}

type PlatformDraftMap = Record<string, Record<string, FieldDraft>>;

function hasStoredSecretFor(platStatus: Record<string, unknown>, field: BridgeConfigFieldDescriptor): boolean {
  const capKey = `has${field.key.charAt(0).toUpperCase()}${field.key.slice(1)}`;
  if (typeof platStatus[capKey] === 'boolean') return platStatus[capKey] as boolean;
  if (typeof platStatus[field.key] === 'string' && (platStatus[field.key] as string).length > 0) return true;
  if (Array.isArray(field.legacyKeys)) {
    for (const legacy of field.legacyKeys) {
      if (typeof platStatus[legacy] === 'string' && (platStatus[legacy] as string).length > 0) return true;
    }
  }
  return false;
}

function defaultFieldValue(platStatus: Record<string, unknown>, field: BridgeConfigFieldDescriptor): string {
  if (field.type === 'secret') return '';
  const stored = platStatus[field.key];
  if (typeof stored === 'string') return stored;
  if (typeof field.defaultValue === 'string') return field.defaultValue;
  if (field.type === 'select' && Array.isArray(field.options) && field.options.length > 0) {
    return field.options[0].value;
  }
  return '';
}

export function BridgeTab() {
  const b = useBridgeState();
  const [draftsByAgent, setDraftsByAgent] = useState<Record<string, PlatformDraftMap>>({});
  const [activePlatformId, setActivePlatformId] = useState<string | null>(null);
  const snapshotBridge = useSettingsStore(s => s.settingsSnapshot.data?.preferences?.bridge);

  const agentKey = b.selectedAgentId || '__default__';
  const agentDrafts = draftsByAgent[agentKey] || {};
  const registeredPlatforms = Array.isArray(b.status?.platforms) ? b.status.platforms : null;

  useEffect(() => {
    if (!registeredPlatforms || registeredPlatforms.length === 0) return;
    if (!activePlatformId || !registeredPlatforms.some((p) => p.id === activePlatformId)) {
      setActivePlatformId(registeredPlatforms[0].id);
    }
  }, [activePlatformId, registeredPlatforms]);

  // Clear dirty flags for a platform after a save completes cleanly
  const clearPlatformDrafts = (platId: string) => {
    setDraftsByAgent((prev) => {
      const current = prev[agentKey];
      if (!current || !current[platId]) return prev;
      const nextAgent = { ...current };
      delete nextAgent[platId];
      return { ...prev, [agentKey]: nextAgent };
    });
  };

  useEffect(() => {
    // No-op hook keeping agentKey scoped cleanly across agent switches
  }, [agentKey]);

  const permissionMode = (b.status?.permissionMode || snapshotBridge?.permissionMode) as BridgePermissionMode | undefined;
  const receiptEnabled = typeof b.status?.receiptEnabled === 'boolean'
    ? b.status.receiptEnabled
    : snapshotBridge?.receiptEnabled;
  const richStreamingEnabled = typeof b.status?.richStreamingEnabled === 'boolean'
    ? b.status.richStreamingEnabled
    : snapshotBridge
      ? snapshotBridge.richStreamingEnabled !== false
      : undefined;
  const globalSettingsPending = !permissionMode || b.globalSettingsSaving;

  const setFieldDraft = (platId: string, fieldKey: string, value: string) => {
    setDraftsByAgent((prev) => ({
      ...prev,
      [agentKey]: {
        ...(prev[agentKey] || {}),
        [platId]: {
          ...(prev[agentKey]?.[platId] || {}),
          [fieldKey]: { value, dirty: true },
        },
      },
    }));
  };

  const renderPluginSection = (descriptor: RegisteredBridgePlatform) => {
    const platId = descriptor.id;
    const platStatus = ((b.status?.[platId] as Record<string, unknown> | undefined) || {});
    const schema = Array.isArray(descriptor.configSchema) ? descriptor.configSchema : [];
    const platDraft = agentDrafts[platId] || {};

    const getFieldValue = (field: BridgeConfigFieldDescriptor) => {
      const draft = platDraft[field.key];
      if (draft?.dirty) return draft.value;
      return defaultFieldValue(platStatus, field);
    };

    const hasUsableField = (field: BridgeConfigFieldDescriptor) => {
      const draft = platDraft[field.key];
      if (field.type === 'secret') {
        return draft?.dirty ? draft.value.trim().length > 0 : hasStoredSecretFor(platStatus, field);
      }
      return getFieldValue(field).trim().length > 0;
    };

    const hasRequiredFields = () => schema.every((field) => !field.required || hasUsableField(field));

    const buildCredentials = () => {
      const creds: Record<string, string> = {};
      for (const field of schema) {
        const draft = platDraft[field.key];
        if (field.type === 'secret') {
          if (draft?.dirty) creds[field.key] = draft.value.trim();
        } else {
          creds[field.key] = getFieldValue(field).trim();
        }
      }
      return creds;
    };

    const shouldUseSavedSecret = () => schema.some(
      (field) => field.type === 'secret' && !platDraft[field.key]?.dirty && hasStoredSecretFor(platStatus, field),
    );

    const credentialFields: CredentialField[] = schema.map((field) => {
      const draft = platDraft[field.key];
      const storedSecret = field.type === 'secret' && !draft?.dirty && hasStoredSecretFor(platStatus, field);
      return {
        key: field.key,
        label: field.label || field.key,
        type: field.type === 'secret' ? 'secret' : field.type === 'select' ? 'select' : 'text',
        value: getFieldValue(field),
        placeholder: storedSecret
          ? t('settings.bridge.secretStoredPlaceholder')
          : (field.placeholder || ''),
        options: field.options,
        onChange: (value: string) => {
          setFieldDraft(platId, field.key, value);
          if (field.type === 'select' && hasRequiredFields()) {
            const nextCreds = { ...buildCredentials(), [field.key]: value.trim() };
            void b.saveBridgeConfig(platId, nextCreds, undefined).then(() => clearPlatformDrafts(platId));
          }
        },
      };
    });

    const allowGuests = platStatus.allowGuests === true;

    return (
      <PlatformSection
        key={platId}
        platform={platId}
        title={descriptor.displayName || platId}
        status={platStatus as { status?: string; error?: string; enabled?: boolean }}
        credentialFields={credentialFields}
        onToggle={async (on) => {
          if (on && !hasRequiredFields()) {
            b.showToast(t('settings.bridge.noCredentials'), 'error');
            return;
          }
          const creds = buildCredentials();
          const hasChanges = Object.keys(creds).length > 0;
          await b.saveBridgeConfig(platId, hasChanges ? creds : null, on);
          clearPlatformDrafts(platId);
        }}
        onTest={() => {
          if (!hasRequiredFields()) {
            b.showToast(t('settings.bridge.noCredentials'), 'error');
            return;
          }
          void b.testPlatform(platId, buildCredentials(), shouldUseSavedSecret());
        }}
        onCredentialBlur={async () => {
          const hasDirty = Object.values(platDraft).some((d) => d.dirty);
          if (!hasDirty) return;
          await b.saveBridgeConfig(platId, buildCredentials(), undefined);
          clearPlatformDrafts(platId);
        }}
        testing={b.testingPlatform === platId}
        hint={descriptor.description}
        ownerUsers={b.status?.knownUsers?.[platId] || []}
        currentOwner={b.status?.owner?.[platId]}
        onOwnerChange={(userId) => b.setOwner(platId, userId)}
      >
        <SettingsRow
          label={t('settings.bridge.allowGuests')}
          hint={t('settings.bridge.allowGuestsDesc')}
          control={
            <Toggle
              on={allowGuests}
              ariaLabel={`${descriptor.displayName || platId}: ${t('settings.bridge.allowGuests')}`}
              onChange={(on) => {
                void b.saveBridgeConfig(platId, null, undefined, { allowGuests: on });
              }}
            />
          }
        />
      </PlatformSection>
    );
  };

  const activeDescriptor = registeredPlatforms && registeredPlatforms.length > 0
    ? (registeredPlatforms.find((p) => p.id === activePlatformId) || registeredPlatforms[0])
    : null;
  const activePlatformStatus = activeDescriptor
    ? ((b.status?.[activeDescriptor.id] as Record<string, unknown> | undefined) || {})
    : null;
  const activeAllowsGuests = activePlatformStatus?.allowGuests === true;

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="bridge">
      <SettingsSection title={t('settings.bridge.globalSettings')}>
        <SettingsRow
          label={t('settings.bridge.permissionMode')}
          hint={t('settings.bridge.permissionModeDesc')}
          control={
            <BridgePermissionModeSelect
              value={permissionMode}
              onChange={(mode) => b.saveGlobalSettings({ permissionMode: mode })}
              disabled={globalSettingsPending}
            />
          }
        />
        <SettingsRow
          label={t('settings.bridge.receiptEnabled')}
          hint={t('settings.bridge.receiptEnabledDesc')}
          control={
            <Toggle
              on={receiptEnabled}
              ariaLabel={t('settings.bridge.receiptEnabled')}
              onChange={(on) => b.saveGlobalSettings({ receiptEnabled: on })}
              disabled={b.globalSettingsSaving}
            />
          }
        />
        <SettingsRow
          label={t('settings.bridge.richStreamingEnabled')}
          hint={t('settings.bridge.richStreamingEnabledDesc')}
          control={
            <Toggle
              on={richStreamingEnabled}
              ariaLabel={t('settings.bridge.richStreamingEnabled')}
              onChange={(on) => b.saveGlobalSettings({ richStreamingEnabled: on })}
              disabled={b.globalSettingsSaving}
            />
          }
        />
      </SettingsSection>

      {registeredPlatforms === null ? (
        <SettingsSection title={t('settings.tabs.bridge')}>
          <div className={styles['settings-section-inset']}>
            <div className={styles['settings-section-hint']}>
              {t('common.loading')}
            </div>
          </div>
        </SettingsSection>
      ) : registeredPlatforms.length === 0 ? (
        <SettingsSection title={t('settings.tabs.bridge')}>
          <div className={styles['settings-section-inset']}>
            <div className={styles['settings-section-hint']}>
              {t('settings.bridge.noPluginsHint')}
            </div>
          </div>
        </SettingsSection>
      ) : (
        <>
          <div
            role="tablist"
            aria-label={t('settings.tabs.bridge')}
            className={styles['bridge-plugin-tabs']}
          >
            {registeredPlatforms.map((descriptor) => {
              const isActive = activeDescriptor?.id === descriptor.id;
              const platStatus = ((b.status?.[descriptor.id] as Record<string, unknown> | undefined) || {});
              return (
                <button
                  key={descriptor.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  data-bridge-tab={descriptor.id}
                  onClick={() => setActivePlatformId(descriptor.id)}
                  className={`${styles['bridge-plugin-tab']}${isActive ? ` ${styles['bridge-plugin-tab-active']}` : ''}`}
                >
                  <BridgeStatusDot status={typeof platStatus.status === 'string' ? platStatus.status : undefined} />
                  <span>{descriptor.displayName || descriptor.id}</span>
                </button>
              );
            })}
          </div>

          {activeDescriptor && (
            <div role="tabpanel" data-bridge-tabpanel={activeDescriptor.id}>
              <SettingsSection title={t('settings.bridge.targetAgent')} surface="plain">
                <div className={`${styles['settings-section-hint']} ${styles['bridge-target-agent-hint']}`}>
                  {t('settings.bridge.targetAgentHint')}
                </div>
                <BridgeAgentRow
                  value={b.selectedAgentId}
                  onChange={b.setSelectedAgentId}
                />
              </SettingsSection>

              {renderPluginSection(activeDescriptor)}

              {activeAllowsGuests && (
                <SettingsSection title={t('settings.agent.publicAgentsMd')}>
                  <div className={styles['settings-section-inset']}>
                    <div className={styles['settings-section-hint']}>
                      {t('settings.agent.publicAgentsMdHint')}
                    </div>
                    <textarea
                      className={styles['settings-textarea']}
                      rows={6}
                      spellCheck={false}
                      value={b.publicAgentsMd}
                      onChange={(e) => b.setPublicAgentsMd(e.target.value)}
                      onBlur={b.savePublicAgentsMd}
                    />
                  </div>
                </SettingsSection>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
