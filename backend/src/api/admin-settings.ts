import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config/index.js';
import { readSettingsFileForUpdate, writeSettingsFile, type SettingsFileYjk } from '../config/settings-file.js';
import { updateSettingsSchema, applyUpdate } from './admin-settings/update.js';
import type { UpdateSettingsInput } from './admin-settings/update.js';
import { buildSettingsResponse } from './admin-settings/settings-response.js';
import type { SettingsResponse } from './admin-settings/settings-response.js';
import { resolveYjkInstallRoot, assertYjkInstallNotRunning, findYjkExe, findYjkPython, resolveYjkSdkSourceFromPublicRepo, extractYjkSdkArchive, yjkApiBranch, copyYjkSdkIntoInstallRoot } from './admin-settings/yjk-setup.js';
import type { YjkAutoConfigureStep } from './admin-settings/yjk-setup.js';

const yjkAutoConfigureSchema = z.object({
  yjk: updateSettingsSchema.shape.yjk.optional(),
});

type YjkAutoConfigureInput = z.infer<typeof yjkAutoConfigureSchema>;

function autoConfigureYjk(input: YjkAutoConfigureInput): { settings: SettingsResponse; steps: YjkAutoConfigureStep[] } {
  const current = readSettingsFileForUpdate();
  const requestedYjk = input.yjk;
  const steps: YjkAutoConfigureStep[] = [];

  const installRoot = resolveYjkInstallRoot(requestedYjk, current);
  steps.push({ name: 'Resolve YJK install root', status: 'applied', details: installRoot });
  assertYjkInstallNotRunning(installRoot);

  const requestedExe = requestedYjk?.exePath?.trim();
  const currentExe = current.yjk?.exePath?.trim();
  const exePath = requestedExe
    || (currentExe && fs.existsSync(currentExe) && fs.statSync(currentExe).isFile() ? currentExe : undefined)
    || findYjkExe(installRoot);
  if (!exePath || !fs.existsSync(exePath) || !fs.statSync(exePath).isFile()) {
    throw new Error(`yjks.exe was not found under YJK install root: ${installRoot}`);
  }
  steps.push({ name: 'Resolve yjks.exe', status: 'applied', details: exePath });

  const requestedPython = requestedYjk?.pythonBin?.trim();
  const currentPython = current.yjk?.pythonBin?.trim();
  const pythonBin = requestedPython
    || (currentPython && fs.existsSync(currentPython) && fs.statSync(currentPython).isFile() ? currentPython : undefined)
    || findYjkPython(installRoot);
  if (!pythonBin || !fs.existsSync(pythonBin) || !fs.statSync(pythonBin).isFile()) {
    throw new Error(`YJK Python 3.10 was not found under YJK install root: ${installRoot}`);
  }
  steps.push({ name: 'Resolve YJK Python', status: 'applied', details: pythonBin });

  const yjk: SettingsFileYjk = {
    ...(current.yjk ?? {}),
    ...(requestedYjk ?? {}),
    installRoot,
    exePath,
    pythonBin,
    sdkArchivePath: requestedYjk?.sdkArchivePath?.trim() || current.yjk?.sdkArchivePath?.trim(),
    workDir: requestedYjk?.workDir?.trim() || current.yjk?.workDir?.trim() || config.yjkWorkDir,
    version: requestedYjk?.version?.trim() || current.yjk?.version?.trim() || '8.0.0',
    timeoutS: requestedYjk?.timeoutS ?? current.yjk?.timeoutS ?? 600,
    invisible: requestedYjk?.invisible ?? current.yjk?.invisible ?? false,
    launcherPrewarm: requestedYjk?.launcherPrewarm ?? current.yjk?.launcherPrewarm ?? 'always',
    launcherPrewarmS: requestedYjk?.launcherPrewarmS ?? current.yjk?.launcherPrewarmS ?? 18,
    directReadyTimeoutS: requestedYjk?.directReadyTimeoutS ?? current.yjk?.directReadyTimeoutS ?? 12,
  };

  const sdkSource = resolveYjkSdkSourceFromPublicRepo(steps);
  const fallbackArchive = yjk.sdkArchivePath;
  const resolvedSdkSource = sdkSource
    ?? (fallbackArchive ? extractYjkSdkArchive(fallbackArchive, yjkApiBranch(), steps) : undefined);
  if (!resolvedSdkSource) {
    throw new Error(
      'YJKAPI SDK could not be prepared. Install Git for automatic Gitee setup, '
      + 'or download SDK/8.0.rar from the official Gitee repository and set YJK SDK Archive Path.',
    );
  }

  const copiedEntries = copyYjkSdkIntoInstallRoot(resolvedSdkSource, installRoot);
  steps.push({
    name: 'Copy YJKAPI SDK files',
    status: 'applied',
    details: `${copiedEntries} top-level entries copied from ${resolvedSdkSource}`,
  });

  writeSettingsFile({ ...current, yjk });
  steps.push({ name: 'Save StructureClaw YJK settings', status: 'applied' });

  return { settings: buildSettingsResponse(), steps };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function adminSettingsRoutes(fastify: FastifyInstance) {
  fastify.get('/', {
    schema: {
      tags: ['Admin'],
      summary: 'Get all application settings with source labels',
    },
  }, async () => buildSettingsResponse());

  fastify.put('/', {
    schema: {
      tags: ['Admin'],
      summary: 'Update application settings',
    },
  }, async (request: FastifyRequest<{ Body: UpdateSettingsInput }>) => {
    const parsed = updateSettingsSchema.parse(request.body);
    const current = readSettingsFileForUpdate();
    const updated = applyUpdate(current, parsed);
    writeSettingsFile(updated);
    return buildSettingsResponse();
  });

  fastify.post('/yjk/auto-configure', {
    schema: {
      tags: ['Admin'],
      summary: 'Auto-configure local YJK runtime settings',
    },
  }, async (
    request: FastifyRequest<{ Body: YjkAutoConfigureInput }>,
    reply: FastifyReply,
  ) => {
    try {
      const parsed = yjkAutoConfigureSchema.parse(request.body ?? {});
      const result = autoConfigureYjk(parsed);
      return {
        success: true,
        steps: result.steps,
        settings: result.settings,
      };
    } catch (error) {
      return reply.code(400).send({
        success: false,
        message: error instanceof Error ? error.message : 'YJK auto configuration failed.',
      });
    }
  });
}
