# 改造基线记录（notes.md）

日期：2026-11-25
平台：linux-x64（Node `v24.22.3` / npm `11.19.1`）

## 基线指标

| 指标 | 基线数值 | 备注 |
| :--- | :--- | :--- |
| `npm install --ignore-scripts` | 9 秒 | 安装 1358 个包，`node scripts/patch-pi-sdk.cjs` 通过 |
| `npm run build:client` | 成功 | 产出 `desktop/main.bundle.cjs`、`desktop/preload.bundle.cjs`、`desktop/dist-renderer` 等 |
| `npm run build:server` | 34 秒 | 服务端内嵌下载并校验 `Node.js v24.15.0 for linux-x64`；所有原生模块 smoke 通过 |
| `dist-server` 目录体积 | `397M` | 含 `linux-x64` 运行时与裁剪后的 `node_modules` |
| `npm run typecheck` | 23 秒 | 0 错误 |

## 实测发现的计划修正点

1. **构建顺序**：必须先执行 `npm run build:client`，再执行 `npm run build:server`（服务端打包依赖 `desktop/dist-renderer`）。
2. **本地签名守卫**：`npm run build:server` 打包 seed 时要求设置 `HANA_SIGN_KEY` 与 `HANA_SIGN_KEYSET`（数组格式 `[{ keyId, publicKey }]`）。本次本地验证使用了 `/tmp/hana-dev-sign/` 下生成的一次性密钥对，未写入仓库。
3. **服务端内置 Node 版本**：实际下载的独立服务端 Node 为 `v24.15.0`（非原计划估算的 `v26.12.1`）。

## 阶段五（减薄核心）对比记录

| 指标 | 基线（Pi 0.80.3） | 阶段五后（Pi 1.6.0 + 插件外置 + 移除 Mobile PWA） | 变化 |
| :--- | :--- | :--- | :--- |
| `dist-server` 目录体积 | `397M` | `272M` | **-125M (-31.5%)** |
| 服务端外部依赖包数 | 637 | 444 | **-193** |
| `nft` 保留文件数 | 9,049 | 5,133 | **-3,916** |
| `dist-server-bundle/index.js` | 4,766.66 kB | 4,535.72 kB | **-231 kB** |
| `npm run typecheck` | 0 错误 | 0 错误 | 持平 |

