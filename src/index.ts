export { CbmClient, serializeArgs } from "./cbm/client.js";
export {
  CliCbmTransport,
  FallbackCbmTransport,
  PersistentCbmTransport,
  createDefaultTransport
} from "./cbm/transport.js";
export type { CbmArgs, CbmCommandResult, CbmClientOptions, CbmTransport } from "./cbm/types.js";
export { findExecutable } from "./cbm/paths.js";
export { loadConfig } from "./config.js";
export type { SydesConfig } from "./config.js";
export {
  createBeforeAgentStartHandler,
  createSydesExtension,
  default,
  maybeSendImpactGuidance,
  observeMutationResult,
  renderDebugContext,
  renderImpactDebugContext,
  shouldInjectForPrompt
} from "./extension.js";
export type { ObservedMutation, SydesExtension, SydesExtensionContext, SydesRuntimeState } from "./extension.js";
export {
  buildAffectedContext,
  buildImpactGuidance,
  boundAffectedContext,
  gitDiffProvider,
  normalizeRepoPath as normalizeImpactPath,
  signatureForAffectedContext
} from "./policy/impact.js";
export {
  buildExplorationGuidance,
  buildRelevantContext,
  boundContext,
  extractHttpRoutes,
  extractTaskIdentifiers,
  normalizeRepoPath,
  rankSymbols,
  resolveCbmProject
} from "./policy/exploration.js";
export type {
  AffectedContext,
  AffectedRelationship,
  AffectedRoute,
  AffectedSymbol,
  BuildRelevantContextOptions,
  CbmProject,
  GitDiffProvider,
  GitDiffResult,
  PolicyCbmClient,
  ProjectResolution,
  RelevantContext,
  RelevantRelationship,
  RelevantSymbol
} from "./policy/types.js";
