export type AgentStatus = 'idle' | 'working' | 'done' | 'error' | 'review';

export type AgentRole =
  | 'manager'
  | 'coder'
  | 'reviewer'
  | 'researcher'
  | 'tester'
  | 'designer'
  | 'deployer';

export interface AgentSnapshot {
  id: string;            // 'M' | 'W1'..'W8'
  role: AgentRole;
  status: AgentStatus;
  task: string | null;
  log: string[];         // last N lines
  worktree: string | null;
  tokens: number;
  startedAt: number | null;
}

export interface DashboardSnapshot {
  task: string | null;
  agents: AgentSnapshot[];
  totalCost: number;
  totalTokens: number;
  runtimeMs: number;
}

// IPC channels
export const IPC = {
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
  AttachImage: 'hive:attach-image',
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
  ListPhotos: 'hive:list-photos',
  GetPhotoFull: 'hive:get-photo-full',
  PickPhotosFolder: 'hive:pick-photos-folder',
} as const;

export type AgentEvent =
  | { type: 'status'; id: string; status: AgentStatus }
  | { type: 'task'; id: string; task: string | null }
  | { type: 'log'; id: string; line: string }
  | { type: 'tokens'; id: string; delta: number }
  | { type: 'cost'; id: string; deltaGBP: number; model: string; inputTokens: number; outputTokens: number }
  | { type: 'role'; id: string; role: AgentRole };
