import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type Properties = Record<string, string | number | boolean>;
type Server = {
  port: number;
  execute(command: string): Promise<string>;
  query(command: string, response: RegExp): Promise<RegExpMatchArray>;
  stop(): Promise<{ code: number; forced: boolean; saveObserved: boolean }>;
};
type Setup = { commands: string[]; details: unknown };

const requireFixture = createRequire(join(__dirname, 'minecraft-core-live.spec.ts'));
const { startVanillaServer } = requireFixture('../../minecraft-runtime/scenarios/vanillaServer.cjs') as {
  startVanillaServer(options: {
    java: string; jar: string; dir: string; properties: Properties; memory: string; startupTimeoutMs: number;
  }): Promise<Server>;
};
const { collectLogsFlat } = requireFixture('../../minecraft-runtime/scenarios/collectLogs.cjs') as {
  collectLogsFlat: {
    serverProperties: Properties;
    setup(options: { username: string; rng: () => number; difficulty: 'peaceful' }): Setup;
  };
};
const { runSetup } = requireFixture('../../minecraft-runtime/tools/scenario-setup.cjs') as {
  runSetup(options: { server: Server; setup: Setup; properties: Properties }): Promise<unknown>;
};

const consoleUrl = 'deskpet://app/main_window/index.html';
const username = 'DesktopCoreE2E';
const installationFile = process.env.MINECRAFT_E2E_INSTALLATION;

async function countServerLogs(server: Server): Promise<number> {
  // A max count of zero asks vanilla to count matching inventory without removing any items.
  const reply = await server.query(`clear ${username} #minecraft:logs 0`,
    new RegExp(`(?:Found (\\d+) matching item(?:\\(s\\)|s)? on player ${username}|No items were found on player ${username})`));
  return Number(reply[1] ?? 0);
}

async function closeElectron(application: ElectronApplication): Promise<void> {
  const child = application.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    void application.close().catch(() => undefined);
    const graceful = await Promise.race([exit.then(() => true), delay(5_000, false)]);
    if (!graceful) {
      child.kill('SIGKILL');
      await exit;
      throw new Error('Electron did not exit after closing the isolated app.');
    }
  }
  expect({ code: child.exitCode, signal: child.signalCode }).toEqual({ code: 0, signal: null });
}

// Run against an existing local vanilla/JDK installation with an unpackaged desktop build.
// MINECRAFT_E2E_INSTALLATION points to installation.json. Opt in only after accepting the Minecraft EULA.
test('desktop Core gathers real logs and stops a second gather on cancel', async () => {
  test.skip(!installationFile || process.env.MINECRAFT_E2E_ACCEPT_EULA !== '1',
    'Set MINECRAFT_E2E_INSTALLATION to installation.json and MINECRAFT_E2E_ACCEPT_EULA=1 to run this live test.');
  if (!installationFile) return;
  test.setTimeout(210_000);
  const testInfo = test.info();

  const installationPath = resolve(installationFile);
  const installation = JSON.parse(await readFile(installationPath, 'utf8')) as {
    java: string; minecraft: { jar: string; version: string };
  };
  expect(installation.minecraft.version).toBe('1.21.8');
  const serverDir = testInfo.outputPath('vanilla-server');
  await mkdir(dirname(serverDir), { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), 'minecraft-core-desktop-'));
  const properties = { ...collectLogsFlat.serverProperties,
    'server-ip': '127.0.0.1', 'online-mode': false, 'enable-rcon': false, 'enable-query': false };
  const evidence: Record<string, unknown> = { minecraftVersion: installation.minecraft.version, bot: username };
  let server: Server | undefined;
  let application: ElectronApplication | undefined;

  try {
    server = await startVanillaServer({
      java: resolve(dirname(installationPath), installation.java),
      jar: resolve(dirname(installationPath), installation.minecraft.jar),
      dir: serverDir, properties, memory: '1G', startupTimeoutMs: 60_000,
    });
    application = await electron.launch({
      args: [join(process.cwd(), '.webpack', process.arch, 'main', 'index.js')],
      env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile },
    });
    expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
    await expect.poll(() => application?.windows().map((window) => window.url()), { timeout: 15_000 }).toContain(consoleUrl);
    const page = application.windows().find((window) => window.url() === consoleUrl);
    if (page === undefined) throw new Error('The Minecraft Companion desktop window did not open.');
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => window.deskpet.app.setLocale('en'));
    await page.getByRole('navigation').getByRole('button', { name: 'Minecraft', exact: true }).click();
    await page.getByLabel('Server address', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('Server port', { exact: true }).fill(String(server.port));
    await page.getByLabel('Bot username / account email', { exact: true }).fill(username);
    await page.getByRole('combobox', { name: /^Authentication/ }).selectOption('offline');
    await page.getByLabel('Server version', { exact: true }).fill(installation.minecraft.version);
    await page.getByRole('combobox', { name: 'Task execution' }).selectOption({ label: 'Core · gather logs' });
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(async () => (await window.deskpet.minecraft.getState()).config?.executorMode)).toBe('core');

    let seed = 43;
    const rng = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const setup = collectLogsFlat.setup({ username, rng, difficulty: 'peaceful' });
    await runSetup({ server, setup, properties });
    evidence.fixture = setup.details;
    const testServer = server;
    const logsBefore = await countServerLogs(testServer);
    expect(logsBefore).toBe(0);

    const task = page.locator('.minecraft-current-task');
    const count = page.getByRole('spinbutton', { name: 'Additional logs' });
    const gather = page.getByRole('button', { name: 'Gather logs', exact: true });
    const cancel = page.getByRole('button', { name: 'Cancel task', exact: true });
    await count.fill('3');
    await gather.click();
    await expect(task).toContainText('Task status: Completed', { timeout: 50_000 });
    const logsAfter = await countServerLogs(testServer);
    evidence.completed = { before: logsBefore, after: logsAfter, requestedAdditional: 3 };
    expect(logsAfter - logsBefore).toBe(3);
    const logItem = page.getByRole('article', { name: 'Inventory' }).getByRole('listitem').filter({ hasText: 'oak_log' });
    await expect(logItem).toContainText(/×\s*3$/u);
    await testInfo.attach('completed', { body: await page.screenshot(), contentType: 'image/png' });

    await count.fill('64');
    await gather.click();
    await expect(task).toContainText('Task status: Running', { timeout: 10_000 });
    await expect.poll(() => countServerLogs(testServer), { timeout: 30_000 }).toBeGreaterThan(logsAfter);
    const logsBeforeCancel = await countServerLogs(testServer);
    await cancel.click();
    await expect(task).toContainText('Task status: Cancelled', { timeout: 15_000 });
    const cancelledCount = await countServerLogs(testServer);
    const afterCancel = [cancelledCount];
    for (let sample = 0; sample < 3; sample += 1) {
      await delay(1_000);
      afterCancel.push(await countServerLogs(testServer));
    }
    evidence.cancelled = { requestedAdditional: 64, before: logsBeforeCancel, sampledLogs: afterCancel };
    expect(afterCancel).toEqual(Array<number>(4).fill(cancelledCount));
    await expect(task).toContainText('Task status: Cancelled');
    await expect(cancel).toBeDisabled();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    await testInfo.attach('cancelled', { body: await page.screenshot(), contentType: 'image/png' });

    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
  } finally {
    try {
      if (application !== undefined) await closeElectron(application);
    } finally {
      try {
        if (server !== undefined) evidence.serverShutdown = await server.stop();
      } finally {
        await rm(profile, { recursive: true, force: true });
        await testInfo.attach('server-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      }
    }
  }
});
