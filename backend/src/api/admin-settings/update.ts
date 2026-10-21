/** Admin settings update schema and its application to the settings file. */
import { z } from 'zod';
import { runPolicyInputSchema } from '../../runtime/run-policy.js';
import { MAX_TOOL_CALLS_PER_TURN_LIMIT } from '../../runtime/limits.js';
import type { SettingsFile, SettingsFileServer, SettingsFileLlm, SettingsFileLogging, SettingsFileAnalysis, SettingsFileStorage, SettingsFileCors, SettingsFileAgent, SettingsFilePkpm, SettingsFileYjk } from '../../config/settings-file.js';

// ---------------------------------------------------------------------------
// PUT input validation
// ---------------------------------------------------------------------------

export const updateSettingsSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65535).optional(),
    host: z.string().trim().min(1).optional(),
    bodyLimitMb: z.number().int().min(1).optional(),
    frontendPort: z.number().int().min(1).max(65535).optional(),
  }).optional(),
  llm: z.object({
    baseUrl: z.string().trim().url().optional(),
    model: z.string().trim().min(1).optional(),
    apiKey: z.string().optional(),
    apiKeyMode: z.enum(['keep', 'replace', 'inherit']).optional(),
    timeoutMs: z.number().int().min(0).optional(),
    maxRetries: z.number().int().min(0).optional(),
  }).optional(),
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
    llmLogEnabled: z.boolean().optional(),
    logMaxAgeDays: z.number().int().min(1).optional(),
    logMaxSize: z.number().int().min(1).optional(),
    llmLogDir: z.string().trim().optional(),
  }).optional(),
  analysis: z.object({
    pythonBin: z.string().trim().optional(),
    pythonTimeoutMs: z.number().int().min(1000).optional(),
    engineManifestPath: z.string().trim().optional(),
  }).optional(),
  storage: z.object({
    reportsDir: z.string().trim().optional(),
    maxFileSize: z.number().int().min(1).optional(),
  }).optional(),
  cors: z.object({
    origins: z.string().trim().optional(),
  }).optional(),
  agent: z.object({
    runPolicy: runPolicyInputSchema.optional(),
    workspaceRoot: z.string().trim().optional(),
    checkpointDir: z.string().trim().optional(),
    allowShell: z.boolean().optional(),
    allowedShellCommands: z.string().trim().optional(),
    shellTimeoutMs: z.number().int().min(1000).optional(),
    maxToolCallsPerTurn: z.number().int().min(1).max(MAX_TOOL_CALLS_PER_TURN_LIMIT).optional(),
  }).optional(),
  pkpm: z.object({
    cyclePath: z.string().trim().optional(),
    workDir: z.string().trim().optional(),
  }).optional(),
  yjk: z.object({
    installRoot: z.string().trim().optional(),
    exePath: z.string().trim().optional(),
    pythonBin: z.string().trim().optional(),
    sdkArchivePath: z.string().trim().optional(),
    workDir: z.string().trim().optional(),
    version: z.string().trim().optional(),
    timeoutS: z.number().int().min(1).optional(),
    invisible: z.boolean().optional(),
    launcherPrewarm: z.enum(['auto', 'always', 'off']).optional(),
    launcherPrewarmS: z.number().int().min(0).optional(),
    directReadyTimeoutS: z.number().int().min(0).optional(),
  }).optional(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export function applyUpdate(current: SettingsFile, input: UpdateSettingsInput): SettingsFile {
  const next: SettingsFile = { ...current };

  if (input.server) {
    const server: SettingsFileServer = { ...(current.server ?? {}) };
    if (input.server.port !== undefined) server.port = input.server.port;
    if (input.server.host !== undefined) server.host = input.server.host;
    if (input.server.bodyLimitMb !== undefined) server.bodyLimitMb = input.server.bodyLimitMb;
    if (input.server.frontendPort !== undefined) server.frontendPort = input.server.frontendPort;
    next.server = server;
  }

  if (input.llm) {
    const llm: SettingsFileLlm = { ...(current.llm ?? {}) };
    if (input.llm.baseUrl !== undefined) llm.baseUrl = input.llm.baseUrl;
    if (input.llm.model !== undefined) llm.model = input.llm.model;
    if (input.llm.timeoutMs !== undefined) llm.timeoutMs = input.llm.timeoutMs;
    if (input.llm.maxRetries !== undefined) llm.maxRetries = input.llm.maxRetries;

    const apiKeyMode = input.llm.apiKeyMode || 'keep';
    if (apiKeyMode === 'inherit') {
      llm.apiKey = undefined;
    } else if (apiKeyMode === 'replace' && input.llm.apiKey !== undefined) {
      llm.apiKey = input.llm.apiKey.trim() || undefined;
    }
    next.llm = llm;
  }

  if (input.logging) {
    const logging: SettingsFileLogging = { ...(current.logging ?? {}) };
    if (input.logging.level !== undefined) logging.level = input.logging.level;
    if (input.logging.llmLogEnabled !== undefined) logging.llmLogEnabled = input.logging.llmLogEnabled;
    if (input.logging.logMaxAgeDays !== undefined) logging.logMaxAgeDays = input.logging.logMaxAgeDays;
    if (input.logging.logMaxSize !== undefined) logging.logMaxSize = input.logging.logMaxSize;
    if (input.logging.llmLogDir !== undefined) logging.llmLogDir = input.logging.llmLogDir;
    next.logging = logging;
  }

  if (input.analysis) {
    const analysis: SettingsFileAnalysis = { ...(current.analysis ?? {}) };
    if (input.analysis.pythonBin !== undefined) analysis.pythonBin = input.analysis.pythonBin;
    if (input.analysis.pythonTimeoutMs !== undefined) analysis.pythonTimeoutMs = input.analysis.pythonTimeoutMs;
    if (input.analysis.engineManifestPath !== undefined) analysis.engineManifestPath = input.analysis.engineManifestPath;
    next.analysis = analysis;
  }

  if (input.storage) {
    const storage: SettingsFileStorage = { ...(current.storage ?? {}) };
    if (input.storage.reportsDir !== undefined) storage.reportsDir = input.storage.reportsDir;
    if (input.storage.maxFileSize !== undefined) storage.maxFileSize = input.storage.maxFileSize;
    next.storage = storage;
  }

  if (input.cors) {
    const cors: SettingsFileCors = { ...(current.cors ?? {}) };
    if (input.cors.origins !== undefined) cors.origins = input.cors.origins;
    next.cors = cors;
  }

  if (input.agent) {
    const agent: SettingsFileAgent = { ...(current.agent ?? {}) };
    if (input.agent.workspaceRoot !== undefined) agent.workspaceRoot = input.agent.workspaceRoot;
    if (input.agent.checkpointDir !== undefined) agent.checkpointDir = input.agent.checkpointDir;
    if (input.agent.allowShell !== undefined) agent.allowShell = input.agent.allowShell;
    if (input.agent.allowedShellCommands !== undefined) agent.allowedShellCommands = input.agent.allowedShellCommands;
    if (input.agent.shellTimeoutMs !== undefined) agent.shellTimeoutMs = input.agent.shellTimeoutMs;
    if (input.agent.maxToolCallsPerTurn !== undefined) agent.runPolicy = { ...agent.runPolicy,
      budgets: { ...agent.runPolicy?.budgets, maxToolCallsPerTurn: input.agent.maxToolCallsPerTurn } };
    if (input.agent.runPolicy !== undefined) agent.runPolicy = input.agent.runPolicy;
    next.agent = agent;
  }

  if (input.pkpm) {
    const pkpm: SettingsFilePkpm = { ...(current.pkpm ?? {}) };
    if (input.pkpm.cyclePath !== undefined) pkpm.cyclePath = input.pkpm.cyclePath;
    if (input.pkpm.workDir !== undefined) pkpm.workDir = input.pkpm.workDir;
    next.pkpm = pkpm;
  }

  if (input.yjk) {
    const yjk: SettingsFileYjk = { ...(current.yjk ?? {}) };
    if (input.yjk.installRoot !== undefined) yjk.installRoot = input.yjk.installRoot;
    if (input.yjk.exePath !== undefined) yjk.exePath = input.yjk.exePath;
    if (input.yjk.pythonBin !== undefined) yjk.pythonBin = input.yjk.pythonBin;
    if (input.yjk.sdkArchivePath !== undefined) yjk.sdkArchivePath = input.yjk.sdkArchivePath;
    if (input.yjk.workDir !== undefined) yjk.workDir = input.yjk.workDir;
    if (input.yjk.version !== undefined) yjk.version = input.yjk.version;
    if (input.yjk.timeoutS !== undefined) yjk.timeoutS = input.yjk.timeoutS;
    if (input.yjk.invisible !== undefined) yjk.invisible = input.yjk.invisible;
    if (input.yjk.launcherPrewarm !== undefined) yjk.launcherPrewarm = input.yjk.launcherPrewarm;
    if (input.yjk.launcherPrewarmS !== undefined) yjk.launcherPrewarmS = input.yjk.launcherPrewarmS;
    if (input.yjk.directReadyTimeoutS !== undefined) yjk.directReadyTimeoutS = input.yjk.directReadyTimeoutS;
    next.yjk = yjk;
  }

  return next;
}
