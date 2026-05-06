// Stack templates — `hive.scaffoldTemplate(workerId, name)` lays down a
// runnable starter project in a worker's worktree in seconds, skipping the
// usual LLM-driven boilerplate phase. Templates are inline data here so the
// build pipeline stays single-package; external template dirs can come later.

import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';

export interface Template {
  name: string;
  description: string;
  files: Record<string, string>;     // relative path -> file contents
  postInstall?: string[];            // commands run sequentially after files written
}

const HTML_SPA_INDEX = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>{{NAME}}</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main>
    <h1>{{NAME}}</h1>
    <p>Edit <code>index.html</code> to begin.</p>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;

const HTML_SPA_CSS = `*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d10;color:#e6e8eb}
main{max-width:720px;margin:8vh auto;padding:0 24px}
h1{font-size:48px;margin:0 0 16px}
p{color:#9aa3ad}
code{background:#1a1f25;padding:2px 6px;border-radius:4px}
`;

const HTML_SPA_JS = `console.log('{{NAME}} ready');
`;

const REACT_VITE_PKG = `{
  "name": "{{NAME}}",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.4.0"
  }
}
`;

const REACT_VITE_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>{{NAME}}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
`;

const REACT_VITE_MAIN = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
`;

const REACT_VITE_APP = `export default function App() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: 32 }}>
      <h1>{{NAME}}</h1>
      <p>Edit <code>src/App.jsx</code> to begin.</p>
    </main>
  );
}
`;

const REACT_VITE_VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()] });
`;

const EXPO_RN_PKG = `{
  "name": "{{NAME}}",
  "version": "0.0.1",
  "main": "expo-router/entry",
  "scripts": {
    "start": "expo start",
    "web": "expo start --web",
    "ios": "expo start --ios",
    "android": "expo start --android"
  },
  "dependencies": {
    "expo": "~52.0.0",
    "expo-router": "~4.0.0",
    "expo-status-bar": "~2.0.0",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "react-native": "0.76.5",
    "react-native-web": "~0.19.13"
  },
  "devDependencies": {
    "@babel/core": "^7.25.0"
  },
  "private": true
}
`;

const EXPO_RN_APP_JSON = `{
  "expo": {
    "name": "{{NAME}}",
    "slug": "{{NAME}}",
    "version": "1.0.0",
    "orientation": "portrait",
    "scheme": "{{NAME}}",
    "userInterfaceStyle": "automatic",
    "ios": { "supportsTablet": false },
    "web": { "bundler": "metro" },
    "plugins": ["expo-router"]
  }
}
`;

const EXPO_RN_APP_INDEX = `import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useState } from 'react';

export default function Home() {
  const [count, setCount] = useState(0);
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{{NAME}}</Text>
      <Text style={styles.subtitle}>Edit app/index.tsx to begin.</Text>
      <Pressable style={styles.btn} onPress={() => setCount(c => c + 1)}>
        <Text style={styles.btnText}>Tapped {count} times</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b0d10', padding: 24 },
  title: { fontSize: 32, fontWeight: '700', color: '#e6e8eb', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#9aa3ad', marginBottom: 24 },
  btn: { backgroundColor: '#22d3ee', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 8 },
  btnText: { color: '#00171f', fontWeight: '700', fontSize: 16 },
});
`;

const EXPO_RN_LAYOUT = `import { Stack } from 'expo-router';

export default function Layout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
`;

const EXPO_RN_BABEL = `module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
`;

const EXPO_RN_PREVIEW = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=375,initial-scale=1"><title>{{NAME}} preview</title>
<style>html,body{margin:0;background:#0b0d10;color:#e6e8eb;font-family:-apple-system,system-ui;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}h1{font-size:28px;margin:0 0 8px}p{color:#9aa3ad;font-size:13px;line-height:1.5;max-width:300px}code{background:#1a1f25;padding:2px 6px;border-radius:4px;font-size:11px}</style>
</head><body>
<h1>{{NAME}}</h1>
<p>Run <code>npm run web</code> in this worktree to start Expo's web bundler, then point the preview at <code>http://localhost:8081</code>.</p>
<p style="margin-top:16px;font-size:11px;">This placeholder shows in the iPhone preview until <code>expo start --web</code> is running.</p>
</body></html>
`;

const EXPRESS_API_PKG = `{
  "name": "{{NAME}}",
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.21.0"
  }
}
`;

const EXPRESS_API_SERVER = `import express from 'express';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/hello', (_req, res) => res.json({ message: 'hello from {{NAME}}' }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(\`{{NAME}} listening on \${port}\`));
`;

const README = `# {{NAME}}

Scaffolded by Hive.
`;

const TEMPLATES: Template[] = [
  {
    name: 'html-spa',
    description: 'Minimal static HTML/CSS/JS — no build step, opens in browser directly.',
    files: {
      'index.html': HTML_SPA_INDEX,
      'styles.css': HTML_SPA_CSS,
      'app.js': HTML_SPA_JS,
      'README.md': README,
    },
  },
  {
    name: 'react-vite',
    description: 'React 18 + Vite dev server. Run `npm run dev` after scaffold.',
    files: {
      'package.json': REACT_VITE_PKG,
      'index.html': REACT_VITE_INDEX_HTML,
      'vite.config.js': REACT_VITE_VITE_CONFIG,
      'src/main.jsx': REACT_VITE_MAIN,
      'src/App.jsx': REACT_VITE_APP,
      'README.md': README,
    },
    postInstall: ['npm install'],
  },
  {
    name: 'expo-rn',
    description: 'Expo + React Native + RN-Web. Targets iOS/Android/web; preview pane shows mobile viewport.',
    files: {
      'package.json': EXPO_RN_PKG,
      'app.json': EXPO_RN_APP_JSON,
      'babel.config.js': EXPO_RN_BABEL,
      'app/_layout.tsx': EXPO_RN_LAYOUT,
      'app/index.tsx': EXPO_RN_APP_INDEX,
      'index.html': EXPO_RN_PREVIEW,
      'README.md': README,
    },
    postInstall: ['npm install'],
  },
  {
    name: 'express-api',
    description: 'Node 18 + Express JSON API with /health and /api/hello.',
    files: {
      'package.json': EXPRESS_API_PKG,
      'server.js': EXPRESS_API_SERVER,
      'README.md': README,
    },
    postInstall: ['npm install'],
  },
];

export function listTemplates(): { name: string; description: string }[] {
  return TEMPLATES.map(t => ({ name: t.name, description: t.description }));
}

export interface ScaffoldResult {
  ok: boolean;
  template: string;
  filesWritten: string[];
  error?: string;
  postInstallOutput?: string;
}

function fillPlaceholders(content: string, projectName: string): string {
  return content.replace(/\{\{NAME\}\}/g, projectName);
}

export async function scaffoldTemplate(
  worktreePath: string,
  templateName: string,
  projectName: string,
  onLog?: (line: string) => void,
): Promise<ScaffoldResult> {
  const tpl = TEMPLATES.find(t => t.name === templateName);
  if (!tpl) {
    return { ok: false, template: templateName, filesWritten: [], error: `unknown template: ${templateName}` };
  }
  const safeName = projectName.trim() || templateName;
  const written: string[] = [];

  for (const [rel, content] of Object.entries(tpl.files)) {
    const abs = path.join(worktreePath, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, fillPlaceholders(content, safeName), 'utf8');
    written.push(rel);
    onLog?.(`→ wrote ${rel}`);
  }

  let postInstallOutput = '';
  if (tpl.postInstall?.length) {
    for (const cmd of tpl.postInstall) {
      onLog?.(`▶ ${cmd}`);
      try {
        const out = await runCommand(cmd, worktreePath, 180_000);
        postInstallOutput += `\n[${cmd}]\n${out.slice(0, 2000)}`;
      } catch (e: any) {
        return {
          ok: false,
          template: templateName,
          filesWritten: written,
          error: `postInstall failed at "${cmd}": ${e.message}`,
          postInstallOutput,
        };
      }
    }
  }

  return { ok: true, template: templateName, filesWritten: written, postInstallOutput };
}

function runCommand(cmd: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true });
    let out = '';
    let err = '';
    const cap = (s: string, more: string) => (s.length > 8000 ? s : (s + more).slice(0, 8000));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', b => { out = cap(out, b.toString()); });
    child.stderr.on('data', b => { err = cap(err, b.toString()); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out || '(no output)');
      else reject(new Error(err.trim() || `exit ${code}`));
    });
  });
}
