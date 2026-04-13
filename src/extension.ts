import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface ContextStatus {
  cwd: string;
  project_dir: string;
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
# Claude Code Fuel Gauge — Context Bridge
# Reads statusline JSON from stdin, writes to ~/.claude/fuel-gauge/{session_id}.json

input=$(cat)

BD_DIR="$HOME/.claude/fuel-gauge"
BD_LOG="$BD_DIR/bridge.log"
mkdir -p "$BD_DIR"

session_id=$(echo "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>>"$BD_LOG")

if [ -z "$session_id" ]; then
  echo "[$(date -Iseconds)] No session_id in input" >> "$BD_LOG"
  exit 0
fi

echo "$input" | python3 -c "
import sys, json, time, os

data = json.load(sys.stdin)
cw = data.get('context_window', {})
cu = cw.get('current_usage') or {}
window_size = cw.get('context_window_size', 200000) or 200000

# Read system overhead from config (written by VS Code extension)
overhead = 18000
config_path = os.path.join(os.path.expanduser('~'), '.claude', 'fuel-gauge', 'config.json')
try:
    with open(config_path) as f:
        cfg = json.load(f)
        overhead = cfg.get('systemOverhead', 18000)
except Exception:
    pass

# Compute percentage including output tokens for accurate effective usage
# (used_percentage from Claude Code is input-only and underreports at high context)
# Subtract system overhead from window size to account for invisible tokens
# (system prompt, tool definitions, MCP configs, CLAUDE.md)
inp = cu.get('input_tokens', 0) or 0
out = cu.get('output_tokens', 0) or 0
cache_create = cu.get('cache_creation_input_tokens', 0) or 0
cache_read = cu.get('cache_read_input_tokens', 0) or 0
total = inp + out + cache_create + cache_read

if total > 0 and window_size > 0:
    effective_window = max(1, window_size - overhead)
    used_pct = min(100.0, total * 100.0 / effective_window)
    remaining_pct = max(0.0, 100.0 - used_pct)
else:
    used_pct = cw.get('used_percentage', 0) or 0
    remaining_pct = cw.get('remaining_percentage', 100) or 100

# Use workspace.project_dir (stable launch dir) with cwd as fallback
ws = data.get('workspace', {})
project_dir = ws.get('project_dir', '') or data.get('cwd', '')

output = {
    'cwd': data.get('cwd', ''),
    'project_dir': project_dir,
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
" > "$BD_DIR/$session_id.json" 2>>"$BD_LOG"
`;

let statusBarItem: vscode.StatusBarItem;
let pollTimer: NodeJS.Timeout | undefined;
let cleanupTimer: NodeJS.Timeout | undefined;

// Terminal Shell Integration tracking (VS Code 1.93+)
let trackedSessionId: string | undefined;
let trackedExecution: vscode.TerminalShellExecution | undefined;
let trackedTerminal: vscode.Terminal | undefined;
let claudeStartTime: number | undefined;
let lastTrackedTimestamp: number | undefined;

function isClaudeCommand(commandLine: string): boolean {
  const firstToken = commandLine.trim().split(/\s+/)[0];
  if (!firstToken) { return false; }
  const basename = path.basename(firstToken);
  return basename === 'claude';
}

function clearTracking() {
  // Delete session file so Tier 3 doesn't pick up stale data
  if (trackedSessionId) {
    const filePath = path.join(os.homedir(), '.claude', 'fuel-gauge', `${trackedSessionId}.json`);
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  }
  trackedSessionId = undefined;
  trackedExecution = undefined;
  trackedTerminal = undefined;
  claudeStartTime = undefined;
  lastTrackedTimestamp = undefined;
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

      // Clean up previous tracking (handles missed onDidEnd events from /exit)
      clearTracking();

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

function writeBridgeConfig() {
  const fuelGaugeDir = path.join(os.homedir(), '.claude', 'fuel-gauge');
  const configPath = path.join(fuelGaugeDir, 'config.json');
  const config = vscode.workspace.getConfiguration('fuel-gauge');
  const systemOverhead = config.get<number>('systemOverhead', 18000);

  try {
    fs.mkdirSync(fuelGaugeDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ systemOverhead }, null, 2) + '\n');
  } catch {
    // Config write is best-effort
  }
}

export function activate(context: vscode.ExtensionContext) {
  setupBridge();
  writeBridgeConfig();
  cleanupStaleSessions();
  cleanupTimer = setInterval(cleanupStaleSessions, 60 * 60 * 1000); // Hourly
  setupTerminalTracking(context);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.tooltip = 'Claude Code Fuel Gauge';
  context.subscriptions.push(statusBarItem);

  startPolling();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fuel-gauge')) {
        writeBridgeConfig();
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
      'Fuel Gauge: Bridge installed. Restart Claude Code to see context usage.'
    );
  } else {
    vscode.window.showWarningMessage(
      `Fuel Gauge: Updated statusLine command (was: ${currentCommand}). Restart Claude Code to apply.`
    );
  }
}

function cleanupStaleSessions() {
  const fuelGaugeDir = path.join(os.homedir(), '.claude', 'fuel-gauge');
  if (!fs.existsSync(fuelGaugeDir)) {
    return;
  }

  const maxAgeMs = 36 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;

  const files = fs.readdirSync(fuelGaugeDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const filePath = path.join(fuelGaugeDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Skip files that can't be read or deleted
    }
  }

  // Trim bridge log to last 50 lines
  const logPath = path.join(fuelGaugeDir, 'bridge.log');
  try {
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
      if (lines.length > 50) {
        fs.writeFileSync(logPath, lines.slice(-50).join('\n'));
      }
    }
  } catch {
    // Log trimming is best-effort
  }
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }

  const config = vscode.workspace.getConfiguration('fuel-gauge');
  const intervalSeconds = config.get<number>('pollInterval', 15);

  updateStatus();
  pollTimer = setInterval(updateStatus, intervalSeconds * 1000);
}

function matchesWorkspace(data: ContextStatus, workspaceRoot: string): boolean {
  // Prefer project_dir (stable launch directory) over cwd (can change mid-session)
  const dir = data.project_dir || data.cwd;
  return dir === workspaceRoot || dir.startsWith(workspaceRoot + '/');
}

function findMatchingSession(): ContextStatus | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const fuelGaugeDir = path.join(os.homedir(), '.claude', 'fuel-gauge');

  if (!fs.existsSync(fuelGaugeDir)) {
    return undefined;
  }

  // Tier 1: Locked onto a specific session — read directly, no scanning
  if (trackedSessionId) {
    try {
      const filePath = path.join(fuelGaugeDir, `${trackedSessionId}.json`);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as ContextStatus;

      // If the file hasn't updated since last poll, check whether /clear
      // (or similar) created a new session for this workspace
      if (lastTrackedTimestamp !== undefined && data.timestamp === lastTrackedTimestamp) {
        const files = fs.readdirSync(fuelGaugeDir).filter(f => f.endsWith('.json'));
        let hasNewer = false;
        for (const file of files) {
          try {
            const otherRaw = fs.readFileSync(path.join(fuelGaugeDir, file), 'utf-8');
            const other: ContextStatus = JSON.parse(otherRaw);
            if (other.session_id !== trackedSessionId &&
                matchesWorkspace(other, workspaceRoot) &&
                other.timestamp > data.timestamp) {
              hasNewer = true;
              break;
            }
          } catch { /* skip */ }
        }
        if (hasNewer) {
          // Release session lock but keep claudeStartTime (terminal still alive)
          trackedSessionId = undefined;
          lastTrackedTimestamp = undefined;
          // Fall through to Tier 2/3 for rediscovery
        } else {
          return data;
        }
      } else {
        lastTrackedTimestamp = data.timestamp;
        return data;
      }
    } catch {
      // File gone or unreadable — clear lock, fall through to Tier 3
      clearTracking();
    }
  }

  // Tier 2: Claude started, waiting to discover session file
  if (claudeStartTime) {
    const startTimeSec = (claudeStartTime / 1000) - 30; // 30s grace for clock skew
    const files = fs.readdirSync(fuelGaugeDir).filter(f => f.endsWith('.json'));
    let newestMatch: ContextStatus | undefined;

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(fuelGaugeDir, file), 'utf-8');
        const data: ContextStatus = JSON.parse(raw);

        if (matchesWorkspace(data, workspaceRoot) && data.timestamp >= startTimeSec) {
          if (!newestMatch || data.timestamp > newestMatch.timestamp) {
            newestMatch = data;
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (newestMatch) {
      trackedSessionId = newestMatch.session_id;
      lastTrackedTimestamp = newestMatch.timestamp;
      return newestMatch;
    }

    // Not found yet — keep waiting (return nothing rather than wrong session)
    return undefined;
  }

  // Tier 3: Fallback — scan all, match workspace, pick newest
  let bestMatch: ContextStatus | undefined;
  const files = fs.readdirSync(fuelGaugeDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(fuelGaugeDir, file), 'utf-8');
      const data: ContextStatus = JSON.parse(raw);

      if (matchesWorkspace(data, workspaceRoot)) {
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
      statusBarItem.text = '$(claude)$(lightbulb-empty) 0%';
      statusBarItem.color = undefined;
      statusBarItem.tooltip = 'Fuel Gauge — No active Claude Code session';
      statusBarItem.show();
      return;
    }

    const pct = Math.round(data.used_percentage);
    const config = vscode.workspace.getConfiguration('fuel-gauge');
    const warningThreshold = config.get<number>('warningThreshold', 60);
    const dangerThreshold = config.get<number>('dangerThreshold', 80);

    // Stale data (>5 min): show last percentage with yield indicator
    const ageSeconds = (Date.now() / 1000) - data.timestamp;
    const isStale = ageSeconds > 300;

    if (isStale) {
      statusBarItem.text = `$(claude)$(lightbulb-empty) ${pct}% $(circle-slash)`;
      statusBarItem.color = undefined;
      statusBarItem.tooltip = `Fuel Gauge — ${pct}% (paused, last update ${Math.round(ageSeconds / 60)}m ago)`;
      statusBarItem.show();
      return;
    }

    statusBarItem.text = `$(claude)$(lightbulb-empty) ${pct}%`;

    if (pct >= dangerThreshold) {
      statusBarItem.color = new vscode.ThemeColor('charts.red');
    } else if (pct >= warningThreshold) {
      statusBarItem.color = new vscode.ThemeColor('charts.yellow');
    } else {
      statusBarItem.color = new vscode.ThemeColor('charts.green');
    }

    statusBarItem.tooltip = `Fuel Gauge — ${pct}%`;

    statusBarItem.show();
  } catch {
    statusBarItem.hide();
  }
}

export function deactivate() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }
  clearTracking();
}
