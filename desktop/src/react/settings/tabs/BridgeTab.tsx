import React, { useState } from 'react';
import { t } from '../helpers';
import { PlatformSection, type CredentialField } from './bridge/PlatformSection';
import { WechatSection } from './bridge/WechatSection';
import { useBridgeState, type RegisteredBridgePlatform } from './bridge/useBridgeState';
import type { BridgeSecretDraft } from './bridge/useBridgeSecretDrafts';
import { BridgeAgentRow } from './bridge/BridgeAgentRow';
import { BridgePermissionModeSelect, type BridgePermissionMode } from './bridge/BridgeWidgets';
import {
  bridgePlatformLabel,
} from '../../utils/bridge-platforms';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { Toggle } from '@/ui';
import { useSettingsStore } from '../store';
import styles from '../Settings.module.css';

function pendingSecret(draft: BridgeSecretDraft) {
  const value = draft.value.trim();
  return draft.dirty && value ? value : null;
}

function hasUsableSecret(draft: BridgeSecretDraft) {
  return draft.dirty ? pendingSecret(draft) !== null : draft.hasStored;
}

function credentialPayload(
  fields: Record<string, string>,
  secretField: string,
  draft: BridgeSecretDraft,
) {
  if (!draft.dirty) return fields;
  return { ...fields, [secretField]: draft.value.trim() };
}

function shouldUseSavedSecret(draft: BridgeSecretDraft) {
  return !draft.dirty && draft.hasStored;
}

function storedSecretPlaceholder(draft: BridgeSecretDraft) {
  return draft.hasStored && !draft.dirty
    ? t('settings.bridge.secretStoredPlaceholder')
    : '';
}

export function BridgeTab() {
  const b = useBridgeState();
  const [genericDrafts, setGenericDrafts] = useState<Record<string, Record<string, { value: string; dirty: boolean }>>>({});
  const snapshotBridge = useSettingsStore(s => s.settingsSnapshot.data?.preferences?.bridge);
  // 注意：不能用 `|| {}` 兜底——空对象会让 Toggle 的 `!!status?.enabled` 显示成"假关"。
  // 传 undefined 让 Toggle 走加载态。
  const tgInfo = b.status?.telegram;
  const fsInfo = b.status?.feishu;
  const dtInfo = b.status?.dingtalk;
  const qqInfo = b.status?.qq;
  const wxInfo = b.status?.wechat;
  const permissionMode = (b.status?.permissionMode || snapshotBridge?.permissionMode) as BridgePermissionMode | undefined;
  const receiptEnabled = typeof b.status?.receiptEnabled === 'boolean'
    ? b.status.receiptEnabled
    : snapshotBridge?.receiptEnabled;
  const richStreamingEnabled = typeof b.status?.richStreamingEnabled === 'boolean'
    ? b.status.richStreamingEnabled
    : snapshotBridge
      ? snapshotBridge.richStreamingEnabled !== false
      : undefined;
  const feishuRegionOptions = [
    { value: 'feishu_cn', label: t('settings.bridge.feishuRegionFeishuCn') },
    { value: 'lark_global', label: t('settings.bridge.feishuRegionLarkGlobal') },
  ];
  const globalSettingsPending = !permissionMode || b.globalSettingsSaving;
  const platformSections: Record<string, React.ReactNode> = {
    wechat: (
      <WechatSection
        status={wxInfo}
        showToast={b.showToast}
        onSaveConfig={(creds, enabled) => b.saveBridgeConfig('wechat', creds, enabled)}
        onReload={b.loadStatus}
        agentId={b.selectedAgentId}
      />
    ),
    telegram: (
      <PlatformSection
        platform="telegram"
        title={bridgePlatformLabel('telegram', t)}
        status={tgInfo}
        credentialFields={[
          {
            key: 'token',
            label: t('settings.bridge.telegramToken'),
            type: 'secret',
            value: b.tgToken,
            placeholder: storedSecretPlaceholder(b.tgTokenDraft),
            onChange: b.setTgToken,
          },
        ]}
        onToggle={async (on) => {
          if (on && !hasUsableSecret(b.tgTokenDraft)) { b.showToast(t('settings.bridge.noToken'), 'error'); return; }
          const credentials = b.tgTokenDraft.dirty
            ? { token: b.tgToken.trim() }
            : null;
          await b.saveBridgeConfig('telegram', credentials, on);
        }}
        onTest={() => {
          if (!hasUsableSecret(b.tgTokenDraft)) { b.showToast(t('settings.bridge.noToken'), 'error'); return; }
          b.testPlatform(
            'telegram',
            credentialPayload({}, 'token', b.tgTokenDraft),
            shouldUseSavedSecret(b.tgTokenDraft),
          );
        }}
        onCredentialBlur={async () => {
          if (b.tgTokenDraft.dirty) {
            await b.saveBridgeConfig(
              'telegram',
              credentialPayload({}, 'token', b.tgTokenDraft),
              undefined,
            );
          }
        }}
        testing={b.testingPlatform === 'telegram'}
        hint={t('settings.bridge.telegramHint')}
        ownerUsers={b.status?.knownUsers?.telegram || []}
        currentOwner={b.status?.owner?.telegram}
        onOwnerChange={(userId) => b.setOwner('telegram', userId)}
      />
    ),
    feishu: (
      <PlatformSection
        platform="feishu"
        title={bridgePlatformLabel('feishu', t)}
        status={fsInfo}
        credentialFields={[
          {
            key: 'region',
            label: t('settings.bridge.feishuRegion'),
            type: 'select',
            value: b.fsRegion,
            onChange: (value) => {
              b.setFsRegion(value as typeof b.fsRegion);
              if (b.fsAppId.trim() && hasUsableSecret(b.fsAppSecretDraft)) {
                b.saveBridgeConfig('feishu', credentialPayload(
                  { appId: b.fsAppId.trim(), region: value },
                  'appSecret',
                  b.fsAppSecretDraft,
                ), undefined);
              }
            },
            options: feishuRegionOptions,
          },
          { key: 'appId', label: t('settings.bridge.feishuAppId'), type: 'text', value: b.fsAppId, onChange: b.setFsAppId },
          {
            key: 'appSecret',
            label: t('settings.bridge.feishuAppSecret'),
            type: 'secret',
            value: b.fsAppSecret,
            placeholder: storedSecretPlaceholder(b.fsAppSecretDraft),
            onChange: b.setFsAppSecret,
          },
        ]}
        onToggle={async (on) => {
          if (on && (!b.fsAppId.trim() || !hasUsableSecret(b.fsAppSecretDraft))) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          await b.saveBridgeConfig('feishu', credentialPayload(
            { appId: b.fsAppId.trim(), region: b.fsRegion },
            'appSecret',
            b.fsAppSecretDraft,
          ), on);
        }}
        onTest={() => {
          if (!b.fsAppId.trim() || !hasUsableSecret(b.fsAppSecretDraft)) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          b.testPlatform('feishu', credentialPayload(
            { appId: b.fsAppId.trim(), region: b.fsRegion },
            'appSecret',
            b.fsAppSecretDraft,
          ), shouldUseSavedSecret(b.fsAppSecretDraft));
        }}
        onCredentialBlur={async () => {
          if (b.fsAppId.trim() && (b.fsAppSecretDraft.dirty || b.fsAppSecretDraft.hasStored)) {
            await b.saveBridgeConfig('feishu', credentialPayload(
              { appId: b.fsAppId.trim(), region: b.fsRegion },
              'appSecret',
              b.fsAppSecretDraft,
            ), undefined);
          }
        }}
        testing={b.testingPlatform === 'feishu'}
        hint={t('settings.bridge.feishuHint')}
        ownerUsers={b.status?.knownUsers?.feishu || []}
        currentOwner={b.status?.owner?.feishu}
        onOwnerChange={(userId) => b.setOwner('feishu', userId)}
      />
    ),
    dingtalk: (
      <PlatformSection
        platform="dingtalk"
        title={bridgePlatformLabel('dingtalk', t)}
        status={dtInfo}
        credentialFields={[
          { key: 'corpId', label: t('settings.bridge.dingtalkCorpId'), type: 'text', value: b.dtCorpId, onChange: b.setDtCorpId },
          { key: 'clientId', label: t('settings.bridge.dingtalkClientId'), type: 'text', value: b.dtClientId, onChange: b.setDtClientId },
          {
            key: 'clientSecret',
            label: t('settings.bridge.dingtalkClientSecret'),
            type: 'secret',
            value: b.dtClientSecret,
            placeholder: storedSecretPlaceholder(b.dtClientSecretDraft),
            onChange: b.setDtClientSecret,
          },
          { key: 'robotCode', label: t('settings.bridge.dingtalkRobotCode'), type: 'text', value: b.dtRobotCode, onChange: b.setDtRobotCode },
          { key: 'apiBaseUrl', label: t('settings.bridge.dingtalkApiBaseUrl'), type: 'text', value: b.dtApiBaseUrl, onChange: b.setDtApiBaseUrl },
        ]}
        onToggle={async (on) => {
          if (on && (!b.dtCorpId.trim() || !b.dtClientId.trim() || !hasUsableSecret(b.dtClientSecretDraft) || !b.dtRobotCode.trim() || !b.dtApiBaseUrl.trim())) { b.showToast(t('settings.bridge.noDingtalkCredentials'), 'error'); return; }
          await b.saveBridgeConfig('dingtalk', credentialPayload({
            corpId: b.dtCorpId.trim(),
            clientId: b.dtClientId.trim(),
            robotCode: b.dtRobotCode.trim(),
            apiBaseUrl: b.dtApiBaseUrl.trim(),
          }, 'clientSecret', b.dtClientSecretDraft), on);
        }}
        onTest={() => {
          if (!b.dtCorpId.trim() || !b.dtClientId.trim() || !hasUsableSecret(b.dtClientSecretDraft) || !b.dtRobotCode.trim() || !b.dtApiBaseUrl.trim()) { b.showToast(t('settings.bridge.noDingtalkCredentials'), 'error'); return; }
          b.testPlatform('dingtalk', credentialPayload({
            corpId: b.dtCorpId.trim(),
            clientId: b.dtClientId.trim(),
            robotCode: b.dtRobotCode.trim(),
            apiBaseUrl: b.dtApiBaseUrl.trim(),
          }, 'clientSecret', b.dtClientSecretDraft), shouldUseSavedSecret(b.dtClientSecretDraft));
        }}
        onCredentialBlur={async () => {
          if (b.dtCorpId.trim() && b.dtClientId.trim() && (b.dtClientSecretDraft.dirty || b.dtClientSecretDraft.hasStored) && b.dtRobotCode.trim() && b.dtApiBaseUrl.trim()) {
            await b.saveBridgeConfig('dingtalk', credentialPayload({
              corpId: b.dtCorpId.trim(),
              clientId: b.dtClientId.trim(),
              robotCode: b.dtRobotCode.trim(),
              apiBaseUrl: b.dtApiBaseUrl.trim(),
            }, 'clientSecret', b.dtClientSecretDraft), undefined);
          }
        }}
        testing={b.testingPlatform === 'dingtalk'}
        hint={t('settings.bridge.dingtalkHint')}
        ownerUsers={b.status?.knownUsers?.dingtalk || []}
        currentOwner={b.status?.owner?.dingtalk}
        onOwnerChange={(userId) => b.setOwner('dingtalk', userId)}
      />
    ),
    qq: (
      <PlatformSection
        platform="qq"
        title={bridgePlatformLabel('qq', t)}
        status={qqInfo}
        credentialFields={[
          { key: 'appID', label: t('settings.bridge.qqAppId'), type: 'text', value: b.qqAppId, onChange: b.setQqAppId },
          {
            key: 'appSecret',
            label: t('settings.bridge.qqAppSecret'),
            type: 'secret',
            value: b.qqAppSecret,
            placeholder: storedSecretPlaceholder(b.qqAppSecretDraft),
            onChange: b.setQqAppSecret,
          },
        ]}
        onToggle={async (on) => {
          if (on && (!b.qqAppId.trim() || !hasUsableSecret(b.qqAppSecretDraft))) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          await b.saveBridgeConfig('qq', credentialPayload(
            { appID: b.qqAppId.trim() },
            'appSecret',
            b.qqAppSecretDraft,
          ), on);
        }}
        onTest={() => {
          if (!b.qqAppId.trim() || !hasUsableSecret(b.qqAppSecretDraft)) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          b.testPlatform('qq', credentialPayload(
            { appID: b.qqAppId.trim() },
            'appSecret',
            b.qqAppSecretDraft,
          ), shouldUseSavedSecret(b.qqAppSecretDraft));
        }}
        onCredentialBlur={async () => {
          if (b.qqAppId.trim() && (b.qqAppSecretDraft.dirty || b.qqAppSecretDraft.hasStored)) {
            await b.saveBridgeConfig('qq', credentialPayload(
              { appID: b.qqAppId.trim() },
              'appSecret',
              b.qqAppSecretDraft,
            ), undefined);
          }
        }}
        testing={b.testingPlatform === 'qq'}
        hint={t('settings.bridge.qqHint')}
        ownerUsers={b.status?.knownUsers?.qq || []}
        currentOwner={b.status?.owner?.qq}
        onOwnerChange={(userId) => b.setOwner('qq', userId)}
      />
    ),
  };

  const renderGenericPluginSection = (descriptor: RegisteredBridgePlatform) => {
    const platId = descriptor.id;
    const platStatus = (b.status?.[platId] as Record<string, any> | undefined) || {};
    const schema = Array.isArray(descriptor.configSchema) ? descriptor.configSchema : [];
    const platDraft = genericDrafts[platId] || {};

    const getFieldValue = (key: string, type: string, defaultValue?: string | boolean) => {
      if (platDraft[key]?.dirty) return platDraft[key].value;
      if (type === 'secret') return '';
      const stored = platStatus[key];
      if (typeof stored === 'string') return stored;
      if (typeof defaultValue === 'string') return defaultValue;
      return '';
    };

    const setFieldValue = (key: string, value: string) => {
      setGenericDrafts((prev) => ({
        ...prev,
        [platId]: {
          ...(prev[platId] || {}),
          [key]: { value, dirty: true },
        },
      }));
    };

    const hasStoredSecretFor = (key: string) => {
      const hasFlag = platStatus[`has${key.charAt(0).toUpperCase()}${key.slice(1)}`];
      if (typeof hasFlag === 'boolean') return hasFlag;
      return typeof platStatus[key] === 'string' && platStatus[key].length > 0;
    };

    const buildCredentials = () => {
      const creds: Record<string, string> = {};
      for (const field of schema) {
        const val = getFieldValue(field.key, field.type, field.defaultValue).trim();
        if (field.type === 'secret') {
          if (platDraft[field.key]?.dirty) creds[field.key] = val;
        } else {
          creds[field.key] = val;
        }
      }
      return creds;
    };

    const hasRequiredFields = () => schema.every((field) => {
      if (!field.required) return true;
      if (field.type === 'secret') {
        return platDraft[field.key]?.dirty
          ? platDraft[field.key].value.trim().length > 0
          : hasStoredSecretFor(field.key);
      }
      return getFieldValue(field.key, field.type, field.defaultValue).trim().length > 0;
    });

    const credentialFields: CredentialField[] = schema.map((field) => ({
      key: field.key,
      label: field.label || field.key,
      type: field.type === 'secret' ? 'secret' : field.type === 'select' ? 'select' : 'text',
      value: getFieldValue(field.key, field.type, field.defaultValue),
      placeholder: field.type === 'secret' && !platDraft[field.key]?.dirty && hasStoredSecretFor(field.key)
        ? t('settings.bridge.secretStoredPlaceholder')
        : (field.placeholder || ''),
      options: field.options,
      onChange: (v: string) => setFieldValue(field.key, v),
    }));

    return (
      <PlatformSection
        platform={platId}
        title={descriptor.displayName || platId}
        status={platStatus}
        credentialFields={credentialFields}
        onToggle={async (on) => {
          if (on && !hasRequiredFields()) {
            b.showToast(t('settings.bridge.noCredentials'), 'error');
            return;
          }
          await b.saveBridgeConfig(platId, buildCredentials(), on);
        }}
        onTest={() => {
          if (!hasRequiredFields()) {
            b.showToast(t('settings.bridge.noCredentials'), 'error');
            return;
          }
          const useSaved = schema.some((f) => f.type === 'secret' && !platDraft[f.key]?.dirty && hasStoredSecretFor(f.key));
          b.testPlatform(platId, buildCredentials(), useSaved);
        }}
        onCredentialBlur={async () => {
          if (Object.values(platDraft).some((d) => d.dirty)) {
            await b.saveBridgeConfig(platId, buildCredentials(), undefined);
          }
        }}
        testing={b.testingPlatform === platId}
        hint={descriptor.description}
        ownerUsers={b.status?.knownUsers?.[platId] || []}
        currentOwner={b.status?.owner?.[platId]}
        onOwnerChange={(userId) => b.setOwner(platId, userId)}
      />
    );
  };

  const registeredPlatforms = Array.isArray(b.status?.platforms) ? b.status.platforms : null;

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

      <SettingsSection title={t('settings.bridge.agentSettings')} surface="plain">
        {/* BridgeAgentRow：tab 级 context，水平平铺头像+名字
         * 未超宽时居中显示，超宽时横向滚动；selected 高亮对齐 AgentCardStack */}
        <BridgeAgentRow
          value={b.selectedAgentId}
          onChange={b.setSelectedAgentId}
        />
      </SettingsSection>

      {/* 对外意识：hint 在上、textarea 在下，直接作为 section body children（单 textarea 不套 row） */}
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

      {registeredPlatforms && registeredPlatforms.length > 0 && (
        <div className="bridge-help-link-row">
          <span className="bridge-help-link" onClick={() => window.dispatchEvent(new Event('hana-show-bridge-tutorial'))}>
            {t('settings.bridge.howTo')}
          </span>
        </div>
      )}

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
              当前未启用任何社交平台插件。请前往「设置 → 插件」安装并启用所需平台（例如 QQ 机器人）。
            </div>
          </div>
        </SettingsSection>
      ) : (
        registeredPlatforms.map((descriptor) => (
          <React.Fragment key={descriptor.id}>
            {platformSections[descriptor.id] ?? renderGenericPluginSection(descriptor)}
          </React.Fragment>
        ))
      )}
    </div>
  );
}
