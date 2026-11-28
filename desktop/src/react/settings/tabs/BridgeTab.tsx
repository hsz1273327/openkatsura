import React, { useEffect, useState } from 'react';
import { t } from '../helpers';
import { PlatformSection, type CredentialField } from './bridge/PlatformSection';
import {
  useBridgeState,
  type BridgeConfigFieldDescriptor,
  type BridgeWorkstation,
  type RegisteredBridgePlatform,
} from './bridge/useBridgeState';
import { BridgePermissionModeSelect, BridgeStatusDot, type BridgePermissionMode } from './bridge/BridgeWidgets';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { SelectWidget, Toggle } from '@/ui';
import { useSettingsStore } from '../store';
import styles from '../Settings.module.css';

interface FieldDraft {
  value: string;
  dirty: boolean;
}

type WorkstationDraftMap = Record<string, Record<string, FieldDraft>>;

function hasStoredSecretFor(record: Record<string, unknown>, field: BridgeConfigFieldDescriptor): boolean {
  const capKey = `has${field.key.charAt(0).toUpperCase()}${field.key.slice(1)}`;
  if (typeof record[capKey] === 'boolean') return record[capKey] as boolean;
  if (typeof record[field.key] === 'string' && (record[field.key] as string).length > 0) return true;
  if (Array.isArray(field.legacyKeys)) {
    for (const legacy of field.legacyKeys) {
      if (typeof record[legacy] === 'string' && (record[legacy] as string).length > 0) return true;
    }
  }
  return false;
}

function defaultFieldValue(record: Record<string, unknown>, field: BridgeConfigFieldDescriptor): string {
  if (field.type === 'secret') return '';
  const stored = record[field.key];
  if (typeof stored === 'string') return stored;
  if (typeof field.defaultValue === 'string') return field.defaultValue;
  if (field.type === 'select' && Array.isArray(field.options) && field.options.length > 0) {
    return field.options[0].value;
  }
  return '';
}

export function BridgeTab() {
  const b = useBridgeState({ includeWorkstations: true });
  const [draftsByWorkstation, setDraftsByWorkstation] = useState<WorkstationDraftMap>({});
  const [activeWorkstationId, setActiveWorkstationId] = useState<string | null>(null);
  const [creatingWorkstation, setCreatingWorkstation] = useState(false);
  const [newWsPlatform, setNewWsPlatform] = useState('');
  const [newWsAgentId, setNewWsAgentId] = useState('');
  const [newWsName, setNewWsName] = useState('');
  const [creatingSubmit, setCreatingSubmit] = useState(false);

  const snapshotBridge = useSettingsStore(s => s.settingsSnapshot.data?.preferences?.bridge);
  const agents = useSettingsStore(s => s.agents);
  const agentOptions = agents.map((agent) => ({ value: agent.id, label: agent.name }));

  const registeredPlatforms: RegisteredBridgePlatform[] | null = Array.isArray(b.workstationPlatforms)
    ? b.workstationPlatforms
    : (Array.isArray(b.status?.platforms) ? b.status.platforms : null);
  const workstations: BridgeWorkstation[] | null = Array.isArray(b.workstations)
    ? b.workstations
    : null;

  useEffect(() => {
    if (registeredPlatforms && registeredPlatforms.length > 0) {
      if (!newWsPlatform || !registeredPlatforms.some((p) => p.id === newWsPlatform)) {
        setNewWsPlatform(registeredPlatforms[0].id);
      }
    }
  }, [newWsPlatform, registeredPlatforms]);

  useEffect(() => {
    const fallbackAgentId = agentOptions[0]?.value || b.selectedAgentId || '';
    if (fallbackAgentId && (!newWsAgentId || (agentOptions.length > 0 && !agentOptions.some((a) => a.value === newWsAgentId)))) {
      setNewWsAgentId(fallbackAgentId);
    }
  }, [agentOptions, b.selectedAgentId, newWsAgentId]);

  useEffect(() => {
    if (!workstations || workstations.length === 0) return;
    if (!activeWorkstationId || !workstations.some((ws) => ws.id === activeWorkstationId)) {
      setActiveWorkstationId(workstations[0].id);
    }
  }, [activeWorkstationId, workstations]);

  const activeWorkstation = !creatingWorkstation && workstations && workstations.length > 0
    ? (workstations.find((ws) => ws.id === activeWorkstationId) || workstations[0])
    : null;

  useEffect(() => {
    if (activeWorkstation?.agentId && b.selectedAgentId !== activeWorkstation.agentId) {
      b.setSelectedAgentId(activeWorkstation.agentId);
    }
  }, [activeWorkstation?.agentId, b]);

  const clearWorkstationDrafts = (wsId: string) => {
    setDraftsByWorkstation((prev) => {
      if (!prev[wsId]) return prev;
      const next = { ...prev };
      delete next[wsId];
      return next;
    });
  };

  const setFieldDraft = (wsId: string, fieldKey: string, value: string) => {
    setDraftsByWorkstation((prev) => ({
      ...prev,
      [wsId]: {
        ...(prev[wsId] || {}),
        [fieldKey]: { value, dirty: true },
      },
    }));
  };

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

  const handleCreateWorkstation = async () => {
    if (!newWsPlatform || !newWsAgentId || creatingSubmit) return;
    setCreatingSubmit(true);
    try {
      const created = await b.createWorkstation?.({
        platform: newWsPlatform,
        agentId: newWsAgentId,
        ...(newWsName.trim() ? { name: newWsName.trim() } : {}),
      });
      if (created?.id) {
        setActiveWorkstationId(created.id);
        setCreatingWorkstation(false);
        setNewWsName('');
      }
    } finally {
      setCreatingSubmit(false);
    }
  };

  const renderWorkstationPanel = (ws: BridgeWorkstation) => {
    const descriptor = registeredPlatforms?.find((p) => p.id === ws.platform) || null;
    const schema = Array.isArray(descriptor?.configSchema) ? descriptor.configSchema : [];
    const wsDraft = draftsByWorkstation[ws.id] || {};
    const boundAgent = agents.find((a) => a.id === ws.agentId);
    const boundAgentName = boundAgent?.name || ws.agentId;

    const getFieldValue = (field: BridgeConfigFieldDescriptor) => {
      const draft = wsDraft[field.key];
      if (draft?.dirty) return draft.value;
      return defaultFieldValue(ws, field);
    };

    const hasUsableField = (field: BridgeConfigFieldDescriptor) => {
      const draft = wsDraft[field.key];
      if (field.type === 'secret') {
        return draft?.dirty ? draft.value.trim().length > 0 : hasStoredSecretFor(ws, field);
      }
      return getFieldValue(field).trim().length > 0;
    };

    const hasRequiredFields = () => schema.every((field) => !field.required || hasUsableField(field));

    const buildCredentials = () => {
      const creds: Record<string, string> = {};
      for (const field of schema) {
        const draft = wsDraft[field.key];
        if (field.type === 'secret') {
          if (draft?.dirty) creds[field.key] = draft.value.trim();
        } else {
          creds[field.key] = getFieldValue(field).trim();
        }
      }
      return creds;
    };

    const shouldUseSavedSecret = () => schema.some(
      (field) => field.type === 'secret' && !wsDraft[field.key]?.dirty && hasStoredSecretFor(ws, field),
    );

    const credentialFields: CredentialField[] = schema.map((field) => {
      const draft = wsDraft[field.key];
      const storedSecret = field.type === 'secret' && !draft?.dirty && hasStoredSecretFor(ws, field);
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
          setFieldDraft(ws.id, field.key, value);
          if (field.type === 'select' && hasRequiredFields()) {
            const nextCreds = { ...buildCredentials(), [field.key]: value.trim() };
            void b.updateWorkstation?.(ws.id, { credentials: nextCreds }).then(() => clearWorkstationDrafts(ws.id));
          }
        },
      };
    });

    const allowGuests = ws.allowGuests === true;

    return (
      <PlatformSection
        key={ws.id}
        platform={ws.platform}
        title={ws.name || descriptor?.displayName || ws.platform}
        hideSectionHeader
        headerRows={
          <SettingsRow
            label={`${t('settings.bridge.workstationPlatform')}: ${descriptor?.displayName || ws.platform}`}
            hint={t('settings.bridge.workstationBoundHint')}
            control={
              <div className={styles['bridge-workstation-actions']}>
                <span className={styles['settings-section-hint']}>
                  {`${t('settings.bridge.targetAgent')}: ${boundAgentName}`}
                </span>
                <button
                  type="button"
                  className={styles['settings-btn-secondary']}
                  onClick={() => void b.deleteWorkstation?.(ws.id)}
                >
                  {t('settings.bridge.deleteWorkstation')}
                </button>
              </div>
            }
          />
        }
        status={{ status: ws.status, error: ws.error || undefined, enabled: ws.enabled }}
        credentialFields={credentialFields}
        onToggle={async (on) => {
          if (on && !hasRequiredFields()) {
            b.showToast(t('settings.bridge.noCredentials'), 'error');
            return;
          }
          const creds = buildCredentials();
          const hasChanges = Object.keys(creds).length > 0;
          await b.updateWorkstation?.(ws.id, {
            ...(hasChanges ? { credentials: creds } : {}),
            enabled: on,
          });
          clearWorkstationDrafts(ws.id);
        }}
        onTest={() => {
          if (!hasRequiredFields()) {
            b.showToast(t('settings.bridge.noCredentials'), 'error');
            return;
          }
          void b.testWorkstation?.(ws.id, buildCredentials(), shouldUseSavedSecret());
        }}
        onCredentialBlur={async () => {
          const hasDirty = Object.values(wsDraft).some((d) => d.dirty);
          if (!hasDirty) return;
          await b.updateWorkstation?.(ws.id, { credentials: buildCredentials() });
          clearWorkstationDrafts(ws.id);
        }}
        testing={b.testingWorkstationId === ws.id}
        hint={descriptor?.description}
        ownerUsers={ws.knownUsers || []}
        currentOwner={ws.owner || undefined}
        onOwnerChange={(userId) => b.updateWorkstation?.(ws.id, { owner: userId || null })}
      >
        <SettingsRow
          label={t('settings.bridge.allowGuests')}
          hint={t('settings.bridge.allowGuestsDesc')}
          control={
            <Toggle
              on={allowGuests}
              ariaLabel={`${ws.name || descriptor?.displayName || ws.platform}: ${t('settings.bridge.allowGuests')}`}
              onChange={(on) => {
                void b.updateWorkstation?.(ws.id, { allowGuests: on });
              }}
            />
          }
        />
        {allowGuests && (
          <div className={styles['settings-section-inset']}>
            <div className={styles['settings-row-label']}>
              {t('settings.agent.publicAgentsMd')}
            </div>
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
        )}
      </PlatformSection>
    );
  };

  const showCreatePanel = Boolean(
    registeredPlatforms
    && registeredPlatforms.length > 0
    && (creatingWorkstation || (workstations !== null && workstations.length === 0)),
  );

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
            {(workstations || []).map((ws) => {
              const isActive = !showCreatePanel && activeWorkstation?.id === ws.id;
              return (
                <button
                  key={ws.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  data-bridge-workstation-tab={ws.id}
                  onClick={() => {
                    setCreatingWorkstation(false);
                    setActiveWorkstationId(ws.id);
                  }}
                  className={`${styles['bridge-plugin-tab']}${isActive ? ` ${styles['bridge-plugin-tab-active']}` : ''}`}
                >
                  <BridgeStatusDot status={typeof ws.status === 'string' ? ws.status : undefined} />
                  <span>{ws.name}</span>
                </button>
              );
            })}
            <button
              type="button"
              className={styles['settings-btn-secondary']}
              onClick={() => setCreatingWorkstation(true)}
            >
              + {t('settings.bridge.addWorkstation')}
            </button>
          </div>

          {showCreatePanel ? (
            <SettingsSection title={t('settings.bridge.createWorkstation')}>
              {workstations !== null && workstations.length === 0 && (
                <div className={styles['settings-section-inset']}>
                  <div className={styles['settings-section-hint']}>
                    {t('settings.bridge.noWorkstationsHint')}
                  </div>
                </div>
              )}
              <SettingsRow
                label={t('settings.bridge.workstationPlatform')}
                hint={t('settings.bridge.workstationBoundHint')}
                control={
                  <SelectWidget
                    value={newWsPlatform}
                    onChange={setNewWsPlatform}
                    options={registeredPlatforms.map((p) => ({
                      value: p.id,
                      label: p.displayName || p.id,
                    }))}
                  />
                }
              />
              <SettingsRow
                label={t('settings.bridge.targetAgent')}
                hint={t('settings.bridge.targetAgentHint')}
                control={
                  <SelectWidget
                    value={newWsAgentId}
                    onChange={setNewWsAgentId}
                    options={agentOptions}
                    disabled={agentOptions.length === 0}
                  />
                }
              />
              <SettingsRow
                label={t('settings.bridge.workstationName')}
                layout="stacked"
                control={
                  <input
                    className={styles['settings-input']}
                    type="text"
                    aria-label={t('settings.bridge.workstationName')}
                    placeholder={t('settings.bridge.workstationNamePlaceholder')}
                    value={newWsName}
                    onChange={(e) => setNewWsName(e.target.value)}
                  />
                }
              />
              <div className={styles['bridge-workstation-actions']}>
                <button
                  type="button"
                  className={styles['settings-btn-primary']}
                  disabled={creatingSubmit || !newWsPlatform || !newWsAgentId}
                  onClick={() => void handleCreateWorkstation()}
                >
                  {t('settings.bridge.createWorkstation')}
                </button>
                {workstations && workstations.length > 0 && (
                  <button
                    type="button"
                    className={styles['settings-btn-secondary']}
                    onClick={() => setCreatingWorkstation(false)}
                  >
                    {t('settings.bridge.cancel')}
                  </button>
                )}
              </div>
            </SettingsSection>
          ) : activeWorkstation ? (
            <div role="tabpanel" data-bridge-tabpanel={activeWorkstation.id}>
              {renderWorkstationPanel(activeWorkstation)}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
