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
} as const;

export type AgentEvent =
  | { type: 'status'; id: string; status: AgentStatus }
  | { type: 'task'; id: string; task: string | null }
  | { type: 'log'; id: string; line: string }
  | { type: 'tokens'; id: string; delta: number }
  | { type: 'role'; id: string; role: AgentRole };
