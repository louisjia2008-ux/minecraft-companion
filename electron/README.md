# DeskPet Electron

The Electron edition is a cross-platform companion that lives beside the native Swift/macOS edition. It has a separate application ID and data directory, and it does not bundle Live2D Cubism Core or a character model.

The console's **Minecraft / 陪玩** page connects a Mineflayer companion to Minecraft Java servers, with task controls, observed game status, inventory and chat. It reuses the migrated Minecraft task engine and can use a selected DeskPet provider for planning. See the [bilingual Minecraft guide](docs/MINECRAFT_COMPANION.md) for setup, authentication, architecture and validation limits. The [local real-server guide](docs/MINECRAFT_LOCAL_SERVER.md) installs the project JDK/server and reruns empty-inventory diamond acceptance; [current evidence](docs/MINECRAFT_REAL_VALIDATION.md) records the completed vanilla run and its limits.

## Local development

```bash
cd electron
npm ci
npm start
```

The first start builds the macOS-only migration helper when running on macOS. Import an allowlisted `live2dcubismcore.min.js` from an official Cubism SDK and then a Live2D model ZIP you are licensed to use.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run test:security
npm run test:minecraft
npm run test:e2e
npm run test:coverage
npm run make
npm run audit:package
```

The tests use fixtures and do not require a provider API key. Real provider calls, a real Core/model rendering pass, signing, notarization, and real Windows/Linux desktop behavior are separate evidence gates.

See the repository-level [English README](../README.md) or [简体中文 README](../README.zh-CN.md) for architecture, platform limitations, migration behavior, security boundaries, packaging, and licensing.
