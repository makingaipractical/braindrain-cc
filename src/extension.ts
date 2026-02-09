import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface ContextStatus {
  cwd: string;
  used_percentage: number;
  remaining_percentage: number;
  total_input_tokens: number;
  total_output_tokens: number;
  context_window_size: number;
  model: string;
  session_id: string;
  timestamp: number;
}

const BRIDGE_SCRIPT = `#!/bin/bash
# BrainDrain CC — Context Bridge
# Reads statusline JSON from stdin, writes to ~/.claude/braindrain/{session_id}.json

input=$(cat)

session_id=$(echo "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)

if [ -z "$session_id" ]; then
  exit 0
fi

mkdir -p "$HOME/.claude/braindrain"

echo "$input" | python3 -c "
import sys, json, time

data = json.load(sys.stdin)
cw = data.get('context_window', {})

output = {
    'cwd': data.get('cwd', ''),
    'used_percentage': cw.get('used_percentage', 0),
    'remaining_percentage': cw.get('remaining_percentage', 100),
    'total_input_tokens': cw.get('total_input_tokens', 0),
    'total_output_tokens': cw.get('total_output_tokens', 0),
    'context_window_size': cw.get('context_window_size', 200000),
    'model': data.get('model', {}).get('id', 'unknown') if isinstance(data.get('model'), dict) else data.get('model', 'unknown'),
    'session_id': data.get('session_id', ''),
    'timestamp': time.time()
}

print(json.dumps(output, indent=2))
" > "$HOME/.claude/braindrain/$session_id.json" 2>/dev/null
`;

let statusBarItem: vscode.StatusBarItem;
let pollTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  setupBridge();

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.tooltip = 'BrainDrain CC';
  context.subscriptions.push(statusBarItem);

  startPolling();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('braindrain-cc')) {
        startPolling();
      }
    })
  );
}

function setupBridge() {
  const claudeDir = path.join(os.homedir(), '.claude');
  const scriptsDir = path.join(claudeDir, 'scripts');
  const bridgePath = path.join(scriptsDir, 'context-bridge.sh');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // Install bridge script
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(bridgePath, BRIDGE_SCRIPT, { mode: 0o755 });

  // Configure statusLine in settings.json
  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch {
    // Start fresh if settings file is corrupt
  }

  const currentCommand = (settings.statusLine as Record<string, unknown>)?.command;
  if (currentCommand === bridgePath) {
    return; // Already configured
  }

  settings.statusLine = {
    type: 'command',
    command: bridgePath,
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  if (!currentCommand) {
    vscode.window.showInformationMessage(
      'BrainDrain CC: Bridge installed. Restart Claude Code to see context usage.'
    );
  } else {
    vscode.window.showWarningMessage(
      `BrainDrain CC: Updated statusLine command (was: ${currentCommand}). Restart Claude Code to apply.`
    );
  }
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }

  const config = vscode.workspace.getConfiguration('braindrain-cc');
  const intervalSeconds = config.get<number>('pollInterval', 15);

  updateStatus();
  pollTimer = setInterval(updateStatus, intervalSeconds * 1000);
}

function findMatchingSession(): ContextStatus | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const braindrainDir = path.join(os.homedir(), '.claude', 'braindrain');

  if (!fs.existsSync(braindrainDir)) {
    return undefined;
  }

  let bestMatch: ContextStatus | undefined;

  const files = fs.readdirSync(braindrainDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(braindrainDir, file), 'utf-8');
      const data: ContextStatus = JSON.parse(raw);

      // Match: session's cwd is the workspace root or a subdirectory of it
      if (data.cwd === workspaceRoot || data.cwd.startsWith(workspaceRoot + '/')) {
        // Pick the most recently updated session
        if (!bestMatch || data.timestamp > bestMatch.timestamp) {
          bestMatch = data;
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return bestMatch;
}

function updateStatus() {
  try {
    const data = findMatchingSession();
    if (!data) {
      statusBarItem.text = '$(thinking) 0%';
      statusBarItem.color = undefined;
      statusBarItem.tooltip = 'BrainDrain CC — No active Claude Code session';
      statusBarItem.show();
      return;
    }

    const pct = Math.round(data.used_percentage);
    const config = vscode.workspace.getConfiguration('braindrain-cc');
    const warningThreshold = config.get<number>('warningThreshold', 60);
    const dangerThreshold = config.get<number>('dangerThreshold', 80);

    // Stale data (>5 min): show last percentage with yield indicator
    const ageSeconds = (Date.now() / 1000) - data.timestamp;
    const isStale = ageSeconds > 300;

    if (isStale) {
      statusBarItem.text = `$(thinking) ${pct}% $(circle-slash)`;
      statusBarItem.color = undefined;
      statusBarItem.tooltip = `BrainDrain CC — ${pct}% (paused, last update ${Math.round(ageSeconds / 60)}m ago)`;
      statusBarItem.show();
      return;
    }

    statusBarItem.text = `$(thinking) ${pct}%`;

    if (pct >= dangerThreshold) {
      statusBarItem.color = new vscode.ThemeColor('charts.red');
    } else if (pct >= warningThreshold) {
      statusBarItem.color = new vscode.ThemeColor('charts.yellow');
    } else {
      statusBarItem.color = new vscode.ThemeColor('charts.green');
    }

    statusBarItem.tooltip = `BrainDrain CC — ${pct}%`;

    statusBarItem.show();
  } catch {
    statusBarItem.hide();
  }
}

export function deactivate() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
}
