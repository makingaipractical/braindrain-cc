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
# WindowPlain CC — Context Bridge
# Reads statusline JSON from stdin, writes to ~/.claude/windowplain-cc/{session_id}.json

input=$(cat)

session_id=$(echo "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)

if [ -z "$session_id" ]; then
  exit 0
fi

mkdir -p "$HOME/.claude/windowplain-cc"

echo "$input" | python3 -c "
import sys, json, time

data = json.load(sys.stdin)
cw = data.get('context_window', {})
cu = cw.get('current_usage') or {}
window_size = cw.get('context_window_size', 200000) or 200000

# Compute percentage including output tokens for accurate effective usage
# (used_percentage from Claude Code is input-only and underreports at high context)
inp = cu.get('input_tokens', 0) or 0
out = cu.get('output_tokens', 0) or 0
cache_create = cu.get('cache_creation_input_tokens', 0) or 0
cache_read = cu.get('cache_read_input_tokens', 0) or 0
total = inp + out + cache_create + cache_read

if total > 0 and window_size > 0:
    used_pct = min(100.0, total * 100.0 / window_size)
    remaining_pct = max(0.0, 100.0 - used_pct)
else:
    used_pct = cw.get('used_percentage', 0) or 0
    remaining_pct = cw.get('remaining_percentage', 100) or 100

output = {
    'cwd': data.get('cwd', ''),
    'used_percentage': used_pct,
    'remaining_percentage': remaining_pct,
    'total_input_tokens': cw.get('total_input_tokens', 0),
    'total_output_tokens': cw.get('total_output_tokens', 0),
    'context_window_size': window_size,
    'model': data.get('model', {}).get('id', 'unknown') if isinstance(data.get('model'), dict) else data.get('model', 'unknown'),
    'session_id': data.get('session_id', ''),
    'timestamp': time.time()
}

print(json.dumps(output, indent=2))
" > "$HOME/.claude/windowplain-cc/$session_id.json" 2>/dev/null
`;

let statusBarItem: vscode.StatusBarItem;
let pollTimer: NodeJS.Timeout | undefined;

// Terminal Shell Integration tracking (VS Code 1.93+)
let trackedSessionId: string | undefined;
let trackedExecution: vscode.TerminalShellExecution | undefined;
let trackedTerminal: vscode.Terminal | undefined;
let claudeStartTime: number | undefined;

function isClaudeCommand(commandLine: string): boolean {
  const firstToken = commandLine.trim().split(/\s+/)[0];
  if (!firstToken) { return false; }
  const basename = path.basename(firstToken);
  return basename === 'claude';
}

function clearTracking() {
  trackedSessionId = undefined;
  trackedExecution = undefined;
  trackedTerminal = undefined;
  claudeStartTime = undefined;
}

function setupTerminalTracking(context: vscode.ExtensionContext) {
  // Feature-detect: Shell Integration API requires VS Code 1.93+
  if (!('onDidStartTerminalShellExecution' in vscode.window)) {
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath;

  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((event) => {
      const commandLine = event.execution.commandLine.value;
      if (!isClaudeCommand(commandLine)) { return; }

      // If we have a workspace, check terminal cwd matches
      if (workspaceRoot && event.terminal.shellIntegration?.cwd) {
        const terminalCwd = event.terminal.shellIntegration.cwd.fsPath;
        if (terminalCwd !== workspaceRoot && !terminalCwd.startsWith(workspaceRoot + '/')) {
          return;
        }
      }

      claudeStartTime = Date.now();
      trackedTerminal = event.terminal;
      trackedExecution = event.execution;
      trackedSessionId = undefined; // Will be discovered on next poll
    })
  );

  context.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution((event) => {
      if (trackedExecution && event.execution === trackedExecution) {
        clearTracking();
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (trackedTerminal && terminal === trackedTerminal) {
        clearTracking();
      }
    })
  );
}

export function activate(context: vscode.ExtensionContext) {
  setupBridge();
  cleanupStaleSessions();
  setupTerminalTracking(context);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.tooltip = 'WindowPlain CC';
  context.subscriptions.push(statusBarItem);

  startPolling();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('windowplain-cc')) {
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
      'WindowPlain CC: Bridge installed. Restart Claude Code to see context usage.'
    );
  } else {
    vscode.window.showWarningMessage(
      `WindowPlain CC: Updated statusLine command (was: ${currentCommand}). Restart Claude Code to apply.`
    );
  }
}

function cleanupStaleSessions() {
  const windowplainDir = path.join(os.homedir(), '.claude', 'windowplain-cc');
  if (!fs.existsSync(windowplainDir)) {
    return;
  }

  const maxAgeMs = 36 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;

  const files = fs.readdirSync(windowplainDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const filePath = path.join(windowplainDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Skip files that can't be read or deleted
    }
  }
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }

  const config = vscode.workspace.getConfiguration('windowplain-cc');
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
  const windowplainDir = path.join(os.homedir(), '.claude', 'windowplain-cc');

  if (!fs.existsSync(windowplainDir)) {
    return undefined;
  }

  // Tier 1: Locked onto a specific session — read directly, no scanning
  if (trackedSessionId) {
    try {
      const filePath = path.join(windowplainDir, `${trackedSessionId}.json`);
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as ContextStatus;
    } catch {
      // File gone or unreadable — clear lock, fall through to Tier 3
      clearTracking();
    }
  }

  // Tier 2: Claude started, waiting to discover session file
  if (claudeStartTime) {
    const startTimeSec = (claudeStartTime / 1000) - 30; // 30s grace for clock skew
    const files = fs.readdirSync(windowplainDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(windowplainDir, file), 'utf-8');
        const data: ContextStatus = JSON.parse(raw);

        const cwdMatches = data.cwd === workspaceRoot || data.cwd.startsWith(workspaceRoot + '/');
        if (cwdMatches && data.timestamp >= startTimeSec) {
          // Found it — lock on
          trackedSessionId = data.session_id;
          return data;
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Not found yet — keep waiting (return nothing rather than wrong session)
    return undefined;
  }

  // Tier 3: Fallback — scan all, match cwd, pick newest (original behavior)
  let bestMatch: ContextStatus | undefined;
  const files = fs.readdirSync(windowplainDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(windowplainDir, file), 'utf-8');
      const data: ContextStatus = JSON.parse(raw);

      if (data.cwd === workspaceRoot || data.cwd.startsWith(workspaceRoot + '/')) {
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
      statusBarItem.text = '🪟 0%';
      statusBarItem.color = undefined;
      statusBarItem.tooltip = 'WindowPlain CC — No active Claude Code session';
      statusBarItem.show();
      return;
    }

    const pct = Math.round(data.used_percentage);
    const config = vscode.workspace.getConfiguration('windowplain-cc');
    const warningThreshold = config.get<number>('warningThreshold', 60);
    const dangerThreshold = config.get<number>('dangerThreshold', 80);

    // Stale data (>5 min): show last percentage with yield indicator
    const ageSeconds = (Date.now() / 1000) - data.timestamp;
    const isStale = ageSeconds > 300;

    if (isStale) {
      statusBarItem.text = `🪟 ${pct}% $(circle-slash)`;
      statusBarItem.color = undefined;
      statusBarItem.tooltip = `WindowPlain CC — ${pct}% (paused, last update ${Math.round(ageSeconds / 60)}m ago)`;
      statusBarItem.show();
      return;
    }

    statusBarItem.text = `🪟 ${pct}%`;

    if (pct >= dangerThreshold) {
      statusBarItem.color = new vscode.ThemeColor('charts.red');
    } else if (pct >= warningThreshold) {
      statusBarItem.color = new vscode.ThemeColor('charts.yellow');
    } else {
      statusBarItem.color = new vscode.ThemeColor('charts.green');
    }

    statusBarItem.tooltip = `WindowPlain CC — ${pct}%`;

    statusBarItem.show();
  } catch {
    statusBarItem.hide();
  }
}

export function deactivate() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  clearTracking();
}
