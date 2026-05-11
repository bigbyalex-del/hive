// Electron's sandboxed preload context cannot resolve relative requires across
// compiled files, so the IPC channel names are inlined here. They must stay in
// sync with src/shared/types.ts.

import { contextBridge, ipcRenderer } from 'electron';

const IPC = {
  RunTask: 'hive:run-task',
  Snapshot: 'hive:snapshot',
  AgentEvent: 'hive:agent-event',
  Pause: 'hive:pause',
  Resume: 'hive:resume',
  Quit: 'hive:quit',
  GetModelConfig: 'hive:get-model-config',
  SetModelConfig: 'hive:set-model-config',
  ListProviders: 'hive:list-providers',
  TranscribeAudio: 'hive:transcribe-audio',
  CancelWorker: 'hive:cancel-worker',
  CancelAll: 'hive:cancel-all',
  ListWorktreeFiles: 'hive:list-worktree-files',
  ReadWorktreeFile: 'hive:read-worktree-file',
  OpenPreviewWindow: 'hive:open-preview-window',
  PreviewBroadcast: 'hive:preview-broadcast',
  CaptureScreen: 'hive:capture-screen',
  SnipRegion: 'hive:snip-region',
  SnipResult: 'hive:snip-result',
  Speak: 'hive:speak',
  ManagerSpoke: 'hive:manager-spoke',
  ListTemplates: 'hive:list-templates',
  ScaffoldTemplate: 'hive:scaffold-template',
  RunSpecInterview: 'hive:run-spec-interview',
  OverrideReview: 'hive:override-review',
  ListProjects: 'hive:list-projects',
  CreateProject: 'hive:create-project',
  SwitchProject: 'hive:switch-project',
  GetActiveProject: 'hive:get-active-project',
  DeleteProject: 'hive:delete-project',
  GetCostSummary: 'hive:get-cost-summary',
  GetWorkerDiff: 'hive:get-worker-diff',
  BabysitStart: 'hive:babysit-start',
  BabysitStop: 'hive:babysit-stop',
  BabysitStatus: 'hive:babysit-status',
  BabysitLog: 'hive:babysit-log',
  ListAdvisors: 'hive:list-advisors',
  ConsultAdvisor: 'hive:consult-advisor',
  RefreshSeeds: 'hive:refresh-seeds',
  RefreshSeedsLog: 'hive:refresh-seeds-log',
  ExtractActions: 'hive:extract-actions',
  RunCouncil: 'hive:run-council',
  RunShipAudit: 'hive:run-ship-audit',
  ShipAuditProgress: 'hive:ship-audit-progress',
  ListAlerts: 'hive:list-alerts',
  AckAlert: 'hive:ack-alert',
  DeleteAlert: 'hive:delete-alert',
  PollAlertsNow: 'hive:poll-alerts-now',
  AlertsConfig: 'hive:alerts-config',
  AlertEvent: 'hive:alert-event',
  ExtractDeployIntent: 'hive:extract-deploy-intent',
  PrepareDeploy: 'hive:prepare-deploy',
  ExecuteDeploy: 'hive:execute-deploy',
  RollbackDeploy: 'hive:rollback-deploy',
  ListDeploys: 'hive:list-deploys',
  DeployLog: 'hive:deploy-log',
  GetPulse: 'hive:get-pulse',
  MarkPulseSeen: 'hive:mark-pulse-seen',
  ListPersonaChats: 'hive:list-persona-chats',
  GetCellPreviews: 'hive:get-cell-previews',
  ListDrafts: 'hive:list-drafts',
  OpenDraftFolder: 'hive:open-draft-folder',
  OpenDraftHero: 'hive:open-draft-hero',
  GenerateNextDraft: 'hive:generate-next-draft',
  GetContentQueue: 'hive:get-content-queue',
  ContentDraftProgress: 'hive:content-draft-progress',
  ListActions: 'hive:list-actions',
  CreateAction: 'hive:create-action',
  UpdateAction: 'hive:update-action',
  UpdateActionStatus: 'hive:update-action-status',
  DeleteAction: 'hive:delete-action',
  GetAction: 'hive:get-action',
  ListCanvases: 'hive:list-canvases',
  GetCanvas: 'hive:get-canvas',
  CreateCanvas: 'hive:create-canvas',
  SaveCanvas: 'hive:save-canvas',
  DeleteCanvas: 'hive:delete-canvas',
};

contextBridge.exposeInMainWorld('hive', {
  runTask: (task: string, imageDataUrl?: string) =>
    ipcRenderer.invoke(IPC.RunTask, imageDataUrl ? { task, imageDataUrl } : task),
  cancelWorker: (id: string) => ipcRenderer.invoke(IPC.CancelWorker, id),
  cancelAll: () => ipcRenderer.invoke(IPC.CancelAll),
  listWorktreeFiles: (workerId: string) => ipcRenderer.invoke(IPC.ListWorktreeFiles, workerId),
  readWorktreeFile: (workerId: string, path: string) => ipcRenderer.invoke(IPC.ReadWorktreeFile, { workerId, path }),
  openPreviewWindow: () => ipcRenderer.invoke(IPC.OpenPreviewWindow),
  pushPreviewHtml: (html: string, projectType?: string) =>
    ipcRenderer.invoke(IPC.PreviewBroadcast, projectType ? { html, projectType } : html),
  captureScreen: () => ipcRenderer.invoke(IPC.CaptureScreen),
  snipRegion: () => ipcRenderer.invoke(IPC.SnipRegion),
  speak: (text: string) => ipcRenderer.invoke(IPC.Speak, text),
  onManagerSpoke: (cb: (text: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, text: string) => cb(text);
    ipcRenderer.on(IPC.ManagerSpoke, listener);
    return () => ipcRenderer.removeListener(IPC.ManagerSpoke, listener);
  },
  onSnipResult: (cb: (res: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, res: any) => cb(res);
    ipcRenderer.on(IPC.SnipResult, listener);
    return () => ipcRenderer.removeListener(IPC.SnipResult, listener);
  },
  snapshot: () => ipcRenderer.invoke(IPC.Snapshot),
  pause: () => ipcRenderer.invoke(IPC.Pause),
  resume: () => ipcRenderer.invoke(IPC.Resume),
  getModelConfig: () => ipcRenderer.invoke(IPC.GetModelConfig),
  setModelConfig: (cfg: any) => ipcRenderer.invoke(IPC.SetModelConfig, cfg),
  listProviders: () => ipcRenderer.invoke(IPC.ListProviders),
  transcribeAudio: (bytes: ArrayBuffer, mime: string) => ipcRenderer.invoke(IPC.TranscribeAudio, { bytes, mime }),
  listTemplates: () => ipcRenderer.invoke(IPC.ListTemplates),
  scaffoldTemplate: (workerId: string, templateName: string, projectName: string) =>
    ipcRenderer.invoke(IPC.ScaffoldTemplate, { workerId, templateName, projectName }),
  runSpecInterview: (task: string) => ipcRenderer.invoke(IPC.RunSpecInterview, task),
  overrideReview: (workerId: string) => ipcRenderer.invoke(IPC.OverrideReview, workerId),
  listProjects: () => ipcRenderer.invoke(IPC.ListProjects),
  switchProject: (id: number) => ipcRenderer.invoke(IPC.SwitchProject, id),
  getActiveProject: () => ipcRenderer.invoke(IPC.GetActiveProject),
  deleteProject: (id: number) => ipcRenderer.invoke(IPC.DeleteProject, id),
  getCostSummary: (projectId?: number) => ipcRenderer.invoke(IPC.GetCostSummary, projectId ?? null),
  getWorkerDiff: (workerId: string) => ipcRenderer.invoke(IPC.GetWorkerDiff, workerId),
  createProject: (input: string | { name: string; gitUrl?: string }) => ipcRenderer.invoke(IPC.CreateProject, input),
  babysitStart: (cfg: any) => ipcRenderer.invoke(IPC.BabysitStart, cfg),
  babysitStop: () => ipcRenderer.invoke(IPC.BabysitStop),
  babysitStatus: () => ipcRenderer.invoke(IPC.BabysitStatus),
  listAdvisors: () => ipcRenderer.invoke(IPC.ListAdvisors),
  consultAdvisor: (personaId: string, question: string, history?: { role: 'user' | 'assistant'; content: string }[]) =>
    ipcRenderer.invoke(IPC.ConsultAdvisor, { personaId, question, history: history ?? [] }),
  refreshSeeds: () => ipcRenderer.invoke(IPC.RefreshSeeds),
  onRefreshSeedsLog: (cb: (line: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, line: string) => cb(line);
    ipcRenderer.on(IPC.RefreshSeedsLog, listener);
    return () => ipcRenderer.removeListener(IPC.RefreshSeedsLog, listener);
  },
  extractActions: (question: string, reply: string, personaName: string) =>
    ipcRenderer.invoke(IPC.ExtractActions, { question, reply, personaName }),
  runCouncil: (question: string) => ipcRenderer.invoke(IPC.RunCouncil, question),
  runShipAudit: () => ipcRenderer.invoke(IPC.RunShipAudit),
  onShipAuditProgress: (cb: (evt: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, evt: any) => cb(evt);
    ipcRenderer.on(IPC.ShipAuditProgress, listener);
    return () => ipcRenderer.removeListener(IPC.ShipAuditProgress, listener);
  },
  listAlerts: (status?: string) => ipcRenderer.invoke(IPC.ListAlerts, status ?? 'open'),
  ackAlert: (id: number) => ipcRenderer.invoke(IPC.AckAlert, id),
  deleteAlert: (id: number) => ipcRenderer.invoke(IPC.DeleteAlert, id),
  pollAlertsNow: () => ipcRenderer.invoke(IPC.PollAlertsNow),
  alertsConfig: () => ipcRenderer.invoke(IPC.AlertsConfig),
  onAlertEvent: (cb: (evt: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, evt: any) => cb(evt);
    ipcRenderer.on(IPC.AlertEvent, listener);
    return () => ipcRenderer.removeListener(IPC.AlertEvent, listener);
  },
  extractDeployIntent: (text: string) => ipcRenderer.invoke(IPC.ExtractDeployIntent, text),
  prepareDeploy: (input: { project: string; channel: 'preview' | 'production'; message: string; skipTypecheck?: boolean }) =>
    ipcRenderer.invoke(IPC.PrepareDeploy, input),
  executeDeploy: (input: { planId: string; confirmation: string }) =>
    ipcRenderer.invoke(IPC.ExecuteDeploy, input),
  rollbackDeploy: (input: { project: string; channel: 'preview' | 'production'; toGroupId: string; reason: string }) =>
    ipcRenderer.invoke(IPC.RollbackDeploy, input),
  listDeploys: (limit?: number) => ipcRenderer.invoke(IPC.ListDeploys, limit ?? 20),
  onDeployLog: (cb: (line: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, line: string) => cb(line);
    ipcRenderer.on(IPC.DeployLog, listener);
    return () => ipcRenderer.removeListener(IPC.DeployLog, listener);
  },
  getPulse: () => ipcRenderer.invoke(IPC.GetPulse),
  markPulseSeen: () => ipcRenderer.invoke(IPC.MarkPulseSeen),
  listPersonaChats: (personaId: string, limit?: number) => ipcRenderer.invoke(IPC.ListPersonaChats, { personaId, limit: limit ?? 100 }),
  getCellPreviews: (personaIds: string[]) => ipcRenderer.invoke(IPC.GetCellPreviews, personaIds),
  listDrafts: () => ipcRenderer.invoke(IPC.ListDrafts),
  openDraftFolder: (slug: string) => ipcRenderer.invoke(IPC.OpenDraftFolder, slug),
  openDraftHero: (slug: string) => ipcRenderer.invoke(IPC.OpenDraftHero, slug),
  generateNextDraft: () => ipcRenderer.invoke(IPC.GenerateNextDraft),
  getContentQueue: () => ipcRenderer.invoke(IPC.GetContentQueue),
  onContentDraftProgress: (cb: (evt: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, evt: any) => cb(evt);
    ipcRenderer.on(IPC.ContentDraftProgress, listener);
    return () => ipcRenderer.removeListener(IPC.ContentDraftProgress, listener);
  },
  onBabysitLog: (cb: (line: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, line: string) => cb(line);
    ipcRenderer.on(IPC.BabysitLog, listener);
    return () => ipcRenderer.removeListener(IPC.BabysitLog, listener);
  },
  onAgentEvent: (cb: (evt: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, evt: any) => cb(evt);
    ipcRenderer.on(IPC.AgentEvent, listener);
    return () => ipcRenderer.removeListener(IPC.AgentEvent, listener);
  },
  listActions: (opts?: { status?: string; projectId?: number | null; limit?: number }) =>
    ipcRenderer.invoke(IPC.ListActions, opts ?? {}),
  createAction: (input: { content: string; personaId?: string | null; projectId?: number | null; priority?: string; status?: string; sourceChatId?: number | null; sourceQuestion?: string | null }) =>
    ipcRenderer.invoke(IPC.CreateAction, input),
  updateAction: (id: number, patch: any) => ipcRenderer.invoke(IPC.UpdateAction, { id, patch }),
  updateActionStatus: (id: number, status: string) => ipcRenderer.invoke(IPC.UpdateActionStatus, { id, status }),
  deleteAction: (id: number) => ipcRenderer.invoke(IPC.DeleteAction, id),
  getAction: (id: number) => ipcRenderer.invoke(IPC.GetAction, id),
  listCanvases: (projectId?: number | null) => ipcRenderer.invoke(IPC.ListCanvases, projectId ?? null),
  getCanvas: (id: number) => ipcRenderer.invoke(IPC.GetCanvas, id),
  createCanvas: (input: { name: string; projectId?: number | null; stateJson?: string }) => ipcRenderer.invoke(IPC.CreateCanvas, input),
  saveCanvas: (input: { id: number; stateJson: string; name?: string }) => ipcRenderer.invoke(IPC.SaveCanvas, input),
  deleteCanvas: (id: number) => ipcRenderer.invoke(IPC.DeleteCanvas, id),
});
