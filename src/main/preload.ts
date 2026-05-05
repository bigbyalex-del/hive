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
};

contextBridge.exposeInMainWorld('hive', {
  runTask: (task: string, imageDataUrl?: string) =>
    ipcRenderer.invoke(IPC.RunTask, imageDataUrl ? { task, imageDataUrl } : task),
  cancelWorker: (id: string) => ipcRenderer.invoke(IPC.CancelWorker, id),
  cancelAll: () => ipcRenderer.invoke(IPC.CancelAll),
  listWorktreeFiles: (workerId: string) => ipcRenderer.invoke(IPC.ListWorktreeFiles, workerId),
  readWorktreeFile: (workerId: string, path: string) => ipcRenderer.invoke(IPC.ReadWorktreeFile, { workerId, path }),
  openPreviewWindow: () => ipcRenderer.invoke(IPC.OpenPreviewWindow),
  pushPreviewHtml: (html: string) => ipcRenderer.invoke(IPC.PreviewBroadcast, html),
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
  onAgentEvent: (cb: (evt: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, evt: any) => cb(evt);
    ipcRenderer.on(IPC.AgentEvent, listener);
    return () => ipcRenderer.removeListener(IPC.AgentEvent, listener);
  },
});
