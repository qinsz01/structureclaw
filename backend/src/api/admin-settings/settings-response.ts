/** Admin settings response: effective values with their source and defaults. */
import path from 'node:path';
import type { RunPolicyInput } from '../../runtime/run-policy.js';
import { readSettingsFile } from '../../config/settings-file.js';
import { runtimeBaseDir } from '../../config/index.js';
import { DEFAULT_MAX_TOOL_CALLS_PER_TURN, MAX_TOOL_CALLS_PER_TURN_LIMIT } from '../../runtime/limits.js';

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

type ValueSource = 'runtime' | 'default';

function stringSource(
  runtimeValue: string | undefined,
  defaultValue: string,
): { value: string; source: ValueSource; defaultValue: string } {
  if (runtimeValue !== undefined && runtimeValue !== '') {
    return { value: runtimeValue, source: 'runtime', defaultValue };
  }
  return { value: defaultValue, source: 'default', defaultValue };
}

function numberSource(
  runtimeValue: number | undefined,
  defaultValue: number,
): { value: number; source: ValueSource; defaultValue: number } {
  if (runtimeValue !== undefined) {
    return { value: runtimeValue, source: 'runtime', defaultValue };
  }
  return { value: defaultValue, source: 'default', defaultValue };
}

function booleanSource(
  runtimeValue: boolean | undefined,
  defaultValue: boolean,
): { value: boolean; source: ValueSource; defaultValue: boolean } {
  if (runtimeValue !== undefined) {
    return { value: runtimeValue, source: 'runtime', defaultValue };
  }
  return { value: defaultValue, source: 'default', defaultValue };
}

// ---------------------------------------------------------------------------
// GET response builder
// ---------------------------------------------------------------------------

type ValueField<T> = { value: T; source: ValueSource; defaultValue: T };

export type SettingsResponse = {
  server: {
    port: ValueField<number>;
    host: ValueField<string>;
    bodyLimitMb: ValueField<number>;
    frontendPort: ValueField<number>;
  };
  llm: {
    baseUrl: ValueField<string>;
    model: ValueField<string>;
    hasApiKey: boolean;
    apiKeySource: 'runtime' | 'env' | 'unset';
    timeoutMs: ValueField<number>;
    maxRetries: ValueField<number>;
  };
  database: {
    url: ValueField<string>;
  };
  logging: {
    level: ValueField<string>;
    llmLogEnabled: ValueField<boolean>;
    logMaxAgeDays: ValueField<number>;
    logMaxSize: ValueField<number>;
    llmLogDir: ValueField<string>;
  };
  analysis: {
    pythonBin: ValueField<string>;
    pythonTimeoutMs: ValueField<number>;
    engineManifestPath: ValueField<string>;
  };
  storage: {
    reportsDir: ValueField<string>;
    maxFileSize: ValueField<number>;
  };
  cors: {
    origins: ValueField<string>;
  };
  agent: {
    workspaceRoot: ValueField<string>;
    checkpointDir: ValueField<string>;
    allowShell: ValueField<boolean>;
    allowedShellCommands: ValueField<string>;
    shellTimeoutMs: ValueField<number>;
    maxToolCallsPerTurn: ValueField<number>;
    runPolicy: ValueField<RunPolicyInput>;
    toolCallCeiling: number;
  };
  pkpm: {
    cyclePath: ValueField<string>;
    workDir: ValueField<string>;
  };
  yjk: {
    installRoot: ValueField<string>;
    exePath: ValueField<string>;
    pythonBin: ValueField<string>;
    sdkArchivePath: ValueField<string>;
    workDir: ValueField<string>;
    version: ValueField<string>;
    timeoutS: ValueField<number>;
    invisible: ValueField<boolean>;
    launcherPrewarm: ValueField<string>;
    launcherPrewarmS: ValueField<number>;
    directReadyTimeoutS: ValueField<number>;
  };
};

export function buildSettingsResponse(): SettingsResponse {
  const file = readSettingsFile();
  const parsedFrontendPort = parseInt(process.env.FRONTEND_PORT || '', 10);
  const defaultFrontendPort = Number.isFinite(parsedFrontendPort) ? parsedFrontendPort : 31416;
  const defaultBackendPort = parseInt(process.env.PORT || '', 10) || 31415;
  const effectiveFrontendPort = file?.server?.frontendPort ?? defaultFrontendPort;
  const effectiveBackendPort = file?.server?.port ?? defaultBackendPort;
  const defaults = {
    port: defaultBackendPort,
    host: '0.0.0.0',
    bodyLimitMb: 20,
    frontendPort: defaultFrontendPort,
    llmBaseUrl: 'https://api.openai.com/v1',
    llmModel: 'gpt-4-turbo-preview',
    llmTimeoutMs: 180000,
    llmMaxRetries: 0,
    databaseUrl: `file:${path.join(runtimeBaseDir, 'data', 'structureclaw.db')}`,
    logLevel: 'info',
    llmLogEnabled: false,
    logMaxAgeDays: 7,
    logMaxSize: 104857600,
    llmLogDir: path.join(runtimeBaseDir, 'logs'),
    pythonBin: process.platform === 'win32'
      ? path.join(runtimeBaseDir, '.venv', 'Scripts', 'python.exe')
      : path.join(runtimeBaseDir, '.venv', 'bin', 'python'),
    pythonTimeoutMs: 600000,
    engineManifestPath: path.join(runtimeBaseDir, 'analysis-engines.json'),
    reportsDir: path.join(runtimeBaseDir, 'reports'),
    maxFileSize: 104857600,
    corsOrigins: [
      `http://localhost:${effectiveFrontendPort}`,
      `http://127.0.0.1:${effectiveFrontendPort}`,
      `http://localhost:${effectiveBackendPort}`,
      `http://127.0.0.1:${effectiveBackendPort}`,
    ].join(','),
    workspaceRoot: runtimeBaseDir,
    checkpointDir: path.join(runtimeBaseDir, 'agent-checkpoints'),
    allowShell: false,
    allowedShellCommands: 'node,npm,python,python3,./sclaw,./sclaw_cn',
    shellTimeoutMs: 300000,
    agentMaxToolCallsPerTurn: DEFAULT_MAX_TOOL_CALLS_PER_TURN,
    pkpmCyclePath: '',
    pkpmWorkDir: path.join(runtimeBaseDir, 'analysis', 'pkpm'),
    yjkInstallRoot: '',
    yjkExePath: '',
    yjkPythonBin: '',
    yjkSdkArchivePath: '',
    yjkWorkDir: path.join(runtimeBaseDir, 'analysis', 'yjk'),
    yjkVersion: '8.0.0',
    yjkTimeoutS: 600,
    yjkInvisible: false,
    yjkLauncherPrewarm: 'auto',
    yjkLauncherPrewarmS: 18,
    yjkDirectReadyTimeoutS: 12,
  };

  const hasSettingsApiKey = !!file?.llm?.apiKey?.trim();
  const hasEnvApiKey = process.env.LLM_API_KEY !== undefined && process.env.LLM_API_KEY.trim().length > 0;
  const hasApiKey = hasSettingsApiKey || hasEnvApiKey;
  const apiKeySource: 'runtime' | 'env' | 'unset' = hasSettingsApiKey ? 'runtime' : hasEnvApiKey ? 'env' : 'unset';

  return {
    server: {
      port: numberSource(file?.server?.port, defaults.port),
      host: stringSource(file?.server?.host, defaults.host),
      bodyLimitMb: numberSource(file?.server?.bodyLimitMb, defaults.bodyLimitMb),
      frontendPort: numberSource(file?.server?.frontendPort, defaults.frontendPort),
    },
    llm: {
      baseUrl: stringSource(file?.llm?.baseUrl, defaults.llmBaseUrl),
      model: stringSource(file?.llm?.model, defaults.llmModel),
      hasApiKey,
      apiKeySource,
      timeoutMs: numberSource(file?.llm?.timeoutMs, defaults.llmTimeoutMs),
      maxRetries: numberSource(file?.llm?.maxRetries, defaults.llmMaxRetries),
    },
    database: {
      url: stringSource(file?.database?.url, defaults.databaseUrl),
    },
    logging: {
      level: stringSource(file?.logging?.level, defaults.logLevel),
      llmLogEnabled: booleanSource(file?.logging?.llmLogEnabled, defaults.llmLogEnabled),
      logMaxAgeDays: numberSource(file?.logging?.logMaxAgeDays, defaults.logMaxAgeDays),
      logMaxSize: numberSource(file?.logging?.logMaxSize, defaults.logMaxSize),
      llmLogDir: stringSource(file?.logging?.llmLogDir, defaults.llmLogDir),
    },
    analysis: {
      pythonBin: stringSource(file?.analysis?.pythonBin, defaults.pythonBin),
      pythonTimeoutMs: numberSource(file?.analysis?.pythonTimeoutMs, defaults.pythonTimeoutMs),
      engineManifestPath: stringSource(file?.analysis?.engineManifestPath, defaults.engineManifestPath),
    },
    storage: {
      reportsDir: stringSource(file?.storage?.reportsDir, defaults.reportsDir),
      maxFileSize: numberSource(file?.storage?.maxFileSize, defaults.maxFileSize),
    },
    cors: {
      origins: stringSource(file?.cors?.origins, defaults.corsOrigins),
    },
    agent: {
      toolCallCeiling: MAX_TOOL_CALLS_PER_TURN_LIMIT,
      runPolicy: { value: file?.agent?.runPolicy ?? {}, source: file?.agent?.runPolicy ? 'runtime' : 'default', defaultValue: {} },
      workspaceRoot: stringSource(file?.agent?.workspaceRoot, defaults.workspaceRoot),
      checkpointDir: stringSource(file?.agent?.checkpointDir, defaults.checkpointDir),
      allowShell: booleanSource(file?.agent?.allowShell, defaults.allowShell),
      allowedShellCommands: stringSource(file?.agent?.allowedShellCommands, defaults.allowedShellCommands),
      shellTimeoutMs: numberSource(file?.agent?.shellTimeoutMs, defaults.shellTimeoutMs),
      maxToolCallsPerTurn: numberSource(file?.agent?.runPolicy?.budgets?.maxToolCallsPerTurn, defaults.agentMaxToolCallsPerTurn),
    },
    pkpm: {
      cyclePath: stringSource(file?.pkpm?.cyclePath, defaults.pkpmCyclePath),
      workDir: stringSource(file?.pkpm?.workDir, defaults.pkpmWorkDir),
    },
    yjk: {
      installRoot: stringSource(file?.yjk?.installRoot, defaults.yjkInstallRoot),
      exePath: stringSource(file?.yjk?.exePath, defaults.yjkExePath),
      pythonBin: stringSource(file?.yjk?.pythonBin, defaults.yjkPythonBin),
      sdkArchivePath: stringSource(file?.yjk?.sdkArchivePath, defaults.yjkSdkArchivePath),
      workDir: stringSource(file?.yjk?.workDir, defaults.yjkWorkDir),
      version: stringSource(file?.yjk?.version, defaults.yjkVersion),
      timeoutS: numberSource(file?.yjk?.timeoutS, defaults.yjkTimeoutS),
      invisible: booleanSource(file?.yjk?.invisible, defaults.yjkInvisible),
      launcherPrewarm: stringSource(file?.yjk?.launcherPrewarm, defaults.yjkLauncherPrewarm),
      launcherPrewarmS: numberSource(file?.yjk?.launcherPrewarmS, defaults.yjkLauncherPrewarmS),
      directReadyTimeoutS: numberSource(file?.yjk?.directReadyTimeoutS, defaults.yjkDirectReadyTimeoutS),
    },
  };
}
