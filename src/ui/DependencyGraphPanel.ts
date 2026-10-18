import * as vscode from 'vscode';
//import * as path from 'path';
import { GraphMasterManager } from '../worker/graphMasterManager';
import { DependencyGraphData} from '../lib/types';

export class DependencyGraphPanel {
  public static currentPanel: DependencyGraphPanel | undefined;
  public static readonly viewType = 'chronos.dependencyGraph';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _graphMasterManager: GraphMasterManager | null;
  private _disposables: vscode.Disposable[] = [];

  public static async createOrShow(
    extensionUri: vscode.Uri,
    graphMasterManager: GraphMasterManager | null,
  ): Promise<void> {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If panel already exists, reveal it
    if (DependencyGraphPanel.currentPanel) {
      DependencyGraphPanel.currentPanel._panel.reveal(column || vscode.ViewColumn.One);
      DependencyGraphPanel.currentPanel.refresh();
      return;
    }

    // Otherwise, create a new panel
    const panel = vscode.window.createWebviewPanel(
      DependencyGraphPanel.viewType,
      'FuncUndo: Dependency Graph',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );

    DependencyGraphPanel.currentPanel = new DependencyGraphPanel(
      panel,
      extensionUri,
      graphMasterManager,
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    graphMasterManager: GraphMasterManager | null,
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._graphMasterManager = graphMasterManager;

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'requestGraph': {
            await this.refresh();
            break;
          }
          case 'openFile': {
            await this._openFileAtLocation(message.filePath, message.line);
            break;
          }
          case 'reindexWorkspace': {
            await vscode.commands.executeCommand('chronos.indexWorkspace');
            await this.refresh();
            break;
          }
        }
      },
      null,
      this._disposables,
    );
  }

  public async refresh(): Promise<void> {
    if (!this._graphMasterManager) {
      this._panel.webview.postMessage({
        command: 'setGraph',
        data: { nodes: [], edges: [] },
      });
      return;
    }

    try {
      const graphData: DependencyGraphData = await this._graphMasterManager.getFullGraph();
      this._panel.webview.postMessage({
        command: 'setGraph',
        data: graphData,
      });
    } catch (err) {
      console.error('[DependencyGraphPanel] Failed to retrieve graph:', err);
      vscode.window.showErrorMessage(`FuncUndo: Failed to retrieve graph: ${err}`);
    }
  }

  private async _openFileAtLocation(filePath: string, line: number): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      });

      const lineIndex = Math.max(0, Math.min(doc.lineCount - 1, line));
      const targetPos = new vscode.Position(lineIndex, 0);
      editor.selection = new vscode.Selection(targetPos, targetPos);
      editor.revealRange(
        new vscode.Range(targetPos, targetPos),
        vscode.TextEditorRevealType.InCenter,
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`FuncUndo: Could not open file '${filePath}': ${err.message}`);
    }
  }

  public dispose(): void {
    DependencyGraphPanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _update(): void {
    this._panel.title = 'FuncUndo: Dependency Graph';
    this._panel.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FuncUndo Dependency Graph</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --card-bg: var(--vscode-sideBar-background, #252526);
      --border: var(--vscode-panel-border, #3c3c3c);
      --accent: var(--vscode-button-background, #0e639c);
      --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
      --accent-fg: var(--vscode-button-foreground, #ffffff);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--font);
      font-size: 13px;
      overflow: hidden;
      width: 100vw;
      height: 100vh;
      display: flex;
      flex-direction: column;
      user-select: none;
    }

    /* Header Bar */
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      z-index: 10;
      gap: 12px;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .title {
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .badge {
      background: var(--badge-bg);
      color: var(--badge-fg);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
    }

    .header-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    input[type="text"] {
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border);
      padding: 4px 10px;
      border-radius: 4px;
      outline: none;
      font-size: 12px;
      width: 200px;
      transition: width 0.2s;
    }

    input[type="text"]:focus {
      border-color: var(--accent);
      width: 250px;
    }

    button {
      background: var(--accent);
      color: var(--accent-fg);
      border: none;
      padding: 5px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    button:hover {
      background: var(--accent-hover);
    }

    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }

    button.secondary:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    /* Main Viewport */
    #viewport {
      flex: 1;
      position: relative;
      overflow: hidden;
      cursor: grab;
    }

    #viewport.dragging {
      cursor: grabbing;
    }

    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    /* Floating Inspector Card */
    #inspector {
      position: absolute;
      bottom: 20px;
      right: 20px;
      width: 320px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      display: none;
      flex-direction: column;
      gap: 10px;
      z-index: 20;
      backdrop-filter: blur(8px);
    }

    #inspector.active {
      display: flex;
    }

    .inspector-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }

    .func-name {
      font-size: 15px;
      font-weight: 600;
      color: #4ec9b0;
      word-break: break-all;
    }

    .func-parent {
      font-size: 11px;
      color: #888888;
      margin-top: 2px;
    }

    .close-btn {
      background: transparent;
      border: none;
      color: #999;
      cursor: pointer;
      padding: 2px;
      font-size: 16px;
      line-height: 1;
    }

    .close-btn:hover {
      color: #fff;
      background: transparent;
    }

    .inspector-details {
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      color: #cccccc;
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .meta-label {
      color: #888;
    }

    .meta-val {
      font-family: monospace;
      color: #9cdcfe;
      max-width: 190px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .inspector-actions {
      margin-top: 6px;
      display: flex;
      gap: 8px;
    }

    .inspector-actions button {
      flex: 1;
      justify-content: center;
    }

    /* Floating Legend */
    #legend {
      position: absolute;
      top: 16px;
      left: 16px;
      background: rgba(30, 30, 30, 0.85);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
      max-height: 220px;
      overflow-y: auto;
      font-size: 11px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      z-index: 10;
      pointer-events: auto;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .legend-color {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .legend-text {
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Empty State */
    #emptyState {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      color: #888;
    }

    #emptyState.active {
      display: flex;
    }

    .empty-icon {
      font-size: 40px;
    }

    .hint-bar {
      position: absolute;
      bottom: 12px;
      left: 16px;
      font-size: 11px;
      color: #666;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <div class="title">
        <span>⚡ FuncUndo Graph</span>
      </div>
      <span class="badge" id="statsBadge">Loading...</span>
    </div>

    <div class="header-controls">
      <button class="secondary" id="heatmapBtn" title="Toggle Risk Heatmap">Risk Heatmap: OFF</button>
      <input type="text" id="searchInput" placeholder="Search functions or files..." />
      <button class="secondary" id="fitBtn" title="Fit to Screen">Fit View</button>
      <button id="refreshBtn" title="Refresh Graph">Refresh</button>
    </div>
  </header>

  <div id="viewport">
    <canvas id="graphCanvas"></canvas>

    <div id="legend"></div>

    <div id="inspector">
      <div class="inspector-header">
        <div>
          <div class="func-name" id="inspName">functionName</div>
          <div class="func-parent" id="inspParent">GLOBAL</div>
        </div>
        <button class="close-btn" id="inspClose">&times;</button>
      </div>
      <div class="inspector-details">
        <div class="meta-row">
          <span class="meta-label">File:</span>
          <span class="meta-val" id="inspFile">file.ts</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Lines:</span>
          <span class="meta-val" id="inspLines">1 - 25</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Calls (Outbound):</span>
          <span class="meta-val" id="inspOutCount">0</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Called By (Inbound):</span>
          <span class="meta-val" id="inspInCount">0</span>
        </div>
        <div class="meta-row" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border);">
          <span class="meta-label">Blast Radius:</span>
          <span class="meta-val" id="inspRiskBadge">SAFE</span>
        </div>
        <div id="inspImpactedSection" style="display:none;font-size:11px;color:#aaa;background:rgba(0,0,0,0.25);padding:6px 8px;border-radius:4px;max-height:85px;overflow-y:auto;">
          <div style="font-weight:600;margin-bottom:4px;color:#f48771;">Impacted Upstream Callers:</div>
          <ul id="inspImpactedList" style="padding-left:14px;margin:0;"></ul>
        </div>
      </div>
      <div class="inspector-actions">
        <button id="jumpCodeBtn">Jump to Code ↗</button>
      </div>
    </div>

    <div id="emptyState">
      <div class="empty-icon">🕸️</div>
      <p>No function dependencies mapped yet.</p>
      <p style="font-size: 11px;">Make sure your workspace is indexed or save a JS/TS file to trigger extraction.</p>
      <button id="reindexBtn">Re-index Workspace</button>
    </div>

    <div class="hint-bar">
      💡 Tip: Click any node to inspect blast radius & connections. Click 'Jump to Code' to open file.
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // DOM Elements
    const canvas = document.getElementById('graphCanvas');
    const ctx = canvas.getContext('2d');
    const viewport = document.getElementById('viewport');
    const statsBadge = document.getElementById('statsBadge');
    const searchInput = document.getElementById('searchInput');
    const fitBtn = document.getElementById('fitBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const reindexBtn = document.getElementById('reindexBtn');
    const emptyState = document.getElementById('emptyState');
    const legend = document.getElementById('legend');

    const inspector = document.getElementById('inspector');
    const inspName = document.getElementById('inspName');
    const inspParent = document.getElementById('inspParent');
    const inspFile = document.getElementById('inspFile');
    const inspLines = document.getElementById('inspLines');
    const inspOutCount = document.getElementById('inspOutCount');
    const inspInCount = document.getElementById('inspInCount');
    const inspRiskBadge = document.getElementById('inspRiskBadge');
    const inspImpactedSection = document.getElementById('inspImpactedSection');
    const inspImpactedList = document.getElementById('inspImpactedList');
    const inspClose = document.getElementById('inspClose');
    const jumpCodeBtn = document.getElementById('jumpCodeBtn');
    const heatmapBtn = document.getElementById('heatmapBtn');

    // Graph Data Structures
    let rawNodes = [];
    let rawEdges = [];
    let simNodes = [];
    let simEdges = [];
    let nodeMap = new Map();

    // Camera State
    let transform = { x: 0, y: 0, k: 1 };
    let isPanning = false;
    let startPan = { x: 0, y: 0 };
    let draggedNode = null;
    let selectedNode = null;
    let hoveredNode = null;
    let filterQuery = '';
    let heatmapMode = false;

    // File Color Palette
    const fileColors = [
      '#4ec9b0', '#569cd6', '#c586c0', '#ce9178', '#dcdcaa',
      '#4fc1ff', '#9cdcfe', '#b5cea8', '#d7ba7d', '#f44747'
    ];
    const fileColorMap = new Map();

    function getFileColor(filePath) {
      if (!fileColorMap.has(filePath)) {
        const color = fileColors[fileColorMap.size % fileColors.length];
        fileColorMap.set(filePath, color);
      }
      return fileColorMap.get(filePath);
    }

    function resizeCanvas() {
      const rect = viewport.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.resetTransform();
      ctx.scale(dpr, dpr);
      render();
    }

    window.addEventListener('resize', resizeCanvas);

    // Initial Request
    vscode.postMessage({ command: 'requestGraph' });

    // Handle messages from Extension Host
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'setGraph') {
        loadGraph(msg.data);
      }
    });

    function getBaseFileName(p) {
      if (!p) return '';
      const parts = p.split(/[\\\\/]/);
      return parts[parts.length - 1];
    }

    function loadGraph(data) {
      rawNodes = data.nodes || [];
      rawEdges = data.edges || [];

      if (rawNodes.length === 0) {
        emptyState.classList.add('active');
        statsBadge.textContent = '0 functions';
        legend.innerHTML = '';
        simNodes = [];
        simEdges = [];
        render();
        return;
      }

      emptyState.classList.remove('active');
      statsBadge.textContent = rawNodes.length + ' functions · ' + rawEdges.length + ' calls';

      // Assign file colors & populate legend
      fileColorMap.clear();
      const uniqueFiles = new Set(rawNodes.map(n => n.filePath).filter(Boolean));
      legend.innerHTML = '<strong style="color:#aaa;margin-bottom:2px;">Files</strong>';
      uniqueFiles.forEach(f => {
        const col = getFileColor(f);
        const item = document.createElement('div');
        item.className = 'legend-item';
        item.innerHTML = '<span class="legend-color" style="background:' + col + '"></span><span class="legend-text" title="' + f + '">' + getBaseFileName(f) + '</span>';
        legend.appendChild(item);
      });

      // Prepare simulation nodes with layout positions
      const width = viewport.clientWidth || 800;
      const height = viewport.clientHeight || 600;

      nodeMap.clear();
      simNodes = rawNodes.map((n, i) => {
        // Arrange initially in circular distribution with slight jitter
        const angle = (i / rawNodes.length) * 2 * Math.PI;
        const radius = Math.min(width, height) * 0.35 + (Math.random() * 40 - 20);
        const simNode = {
          ...n,
          x: width / 2 + Math.cos(angle) * radius,
          y: height / 2 + Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
          radius: 20,
          color: getFileColor(n.filePath),
          riskLevel: n.riskLevel || 'SAFE',
          blastRadiusCount: n.blastRadiusCount || 0,
          impactedFunctions: n.impactedFunctions || [],
          inboundCount: 0,
          outboundCount: 0,
          inbound: [],
          outbound: [],
        };
        nodeMap.set(n.id, simNode);
        return simNode;
      });

      // Map edges to objects
      simEdges = [];
      rawEdges.forEach(e => {
        const source = nodeMap.get(e.source);
        const target = nodeMap.get(e.target);
        if (source && target) {
          source.outboundCount++;
          target.inboundCount++;
          source.outbound.push(target);
          target.inbound.push(source);
          simEdges.push({ source, target });
        }
      });

      // Run force simulation
      runPhysicsSimulation();
      centerGraph();
    }

    // Force-directed layout simulation
    function runPhysicsSimulation() {
      const steps = 180;
      const kRepel = 2400;
      const kSpring = 0.04;
      const desiredDist = 110;
      const damping = 0.85;

      const width = viewport.clientWidth || 800;
      const height = viewport.clientHeight || 600;
      const cx = width / 2;
      const cy = height / 2;

      for (let s = 0; s < steps; s++) {
        // 1. Repulsion between all node pairs
        for (let i = 0; i < simNodes.length; i++) {
          for (let j = i + 1; j < simNodes.length; j++) {
            const na = simNodes[i];
            const nb = simNodes[j];
            const dx = nb.x - na.x;
            const dy = nb.y - na.y;
            const distSq = dx * dx + dy * dy + 1;
            const dist = Math.sqrt(distSq);

            const force = kRepel / distSq;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;

            na.vx -= fx;
            na.vy -= fy;
            nb.vx += fx;
            nb.vy += fy;
          }
        }

        // 2. Attraction along edges
        for (let i = 0; i < simEdges.length; i++) {
          const edge = simEdges[i];
          const na = edge.source;
          const nb = edge.target;
          const dx = nb.x - na.x;
          const dy = nb.y - na.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const diff = dist - desiredDist;
          const force = diff * kSpring;

          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          na.vx += fx;
          na.vy += fy;
          nb.vx -= fx;
          nb.vy -= fy;
        }

        // 3. Center gravity
        for (let i = 0; i < simNodes.length; i++) {
          const n = simNodes[i];
          n.vx += (cx - n.x) * 0.008;
          n.vy += (cy - n.y) * 0.008;

          n.vx *= damping;
          n.vy *= damping;
          n.x += n.vx;
          n.y += n.vy;
        }
      }
    }

    function centerGraph() {
      if (simNodes.length === 0) return;

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      simNodes.forEach(n => {
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      });

      const width = viewport.clientWidth || 800;
      const height = viewport.clientHeight || 600;
      const graphW = maxX - minX + 160;
      const graphH = maxY - minY + 160;

      const scaleX = width / graphW;
      const scaleY = height / graphH;
      const scale = Math.min(Math.max(Math.min(scaleX, scaleY), 0.3), 1.5);

      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;

      transform = {
        k: scale,
        x: width / 2 - midX * scale,
        y: height / 2 - midY * scale,
      };

      render();
    }

    // Canvas Rendering
    function render() {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      ctx.clearRect(0, 0, width, height);

      ctx.save();
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.k, transform.k);

      // Check active highlighted sets if node selected
      const isFiltered = filterQuery.trim().length > 0;
      const filterLower = filterQuery.toLowerCase();

      const activeIncoming = new Set();
      const activeOutgoing = new Set();
      const blastRadiusSet = new Set(selectedNode ? (selectedNode.impactedFunctions || []) : []);
      if (selectedNode) {
        selectedNode.inbound.forEach(n => activeIncoming.add(n.id));
        selectedNode.outbound.forEach(n => activeOutgoing.add(n.id));
        blastRadiusSet.add(selectedNode.id);
      }

      // Draw Edges
      simEdges.forEach(edge => {
        const s = edge.source;
        const t = edge.target;

        const isBlastEdge = selectedNode && blastRadiusSet.has(s.id) && blastRadiusSet.has(t.id);
        const isConnectedToSelected = selectedNode && (s.id === selectedNode.id || t.id === selectedNode.id);
        const isDimmed = selectedNode && !isConnectedToSelected && !isBlastEdge;

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);

        if (isBlastEdge) {
          ctx.strokeStyle = '#f44747';
          ctx.lineWidth = 2.5;
        } else if (isConnectedToSelected) {
          ctx.strokeStyle = (s.id === selectedNode.id) ? '#4fc1ff' : '#ffaa00';
          ctx.lineWidth = 2.0;
        } else if (isDimmed) {
          ctx.strokeStyle = 'rgba(70, 70, 70, 0.15)';
          ctx.lineWidth = 1;
        } else {
          ctx.strokeStyle = 'rgba(120, 120, 120, 0.45)';
          ctx.lineWidth = 1.2;
        }
        ctx.stroke();

        // Draw directional arrowhead at target edge
        drawArrow(ctx, s.x, s.y, t.x, t.y, t.radius, isBlastEdge || isConnectedToSelected ? 9 : 6);
      });

      // Draw Nodes
      simNodes.forEach(node => {
        const isMatch = !isFiltered ||
          node.name.toLowerCase().includes(filterLower) ||
          (node.filePath && node.filePath.toLowerCase().includes(filterLower));

        const isSel = selectedNode && selectedNode.id === node.id;
        const isHov = hoveredNode && hoveredNode.id === node.id;
        const isBlastImpacted = selectedNode && !isSel && blastRadiusSet.has(node.id);
        const isNeighbor = activeIncoming.has(node.id) || activeOutgoing.has(node.id);

        let alpha = 1;
        if (selectedNode && !isSel && !isNeighbor && !isBlastImpacted) {
          alpha = 0.2;
        }
        if (isFiltered && !isMatch) {
          alpha = 0.15;
        }

        ctx.save();
        ctx.globalAlpha = alpha;

        // Node Circle / Background
        ctx.beginPath();
        const r = isSel ? 24 : (isHov || isBlastImpacted) ? 22 : 18;
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = '#222224';
        ctx.fill();

        // Node Border Color
        let borderColor = node.color;
        if (isSel) {
          borderColor = '#ffffff';
        } else if (isBlastImpacted) {
          borderColor = (node.riskLevel === 'DANGER' || selectedNode.riskLevel === 'DANGER') ? '#f44747' : '#d7ba7d';
        } else if (heatmapMode) {
          borderColor = node.riskLevel === 'DANGER' ? '#f44747' : (node.riskLevel === 'WARNING' ? '#d7ba7d' : '#4ec9b0');
        } else if (activeOutgoing.has(node.id)) {
          borderColor = '#4fc1ff';
        } else if (activeIncoming.has(node.id)) {
          borderColor = '#ffaa00';
        }

        ctx.lineWidth = isSel ? 3.5 : (isBlastImpacted ? 3.0 : (isNeighbor ? 2.5 : 2));
        ctx.strokeStyle = borderColor;
        ctx.stroke();

        // Node Glow for selected or blast impacted
        if (isSel || isBlastImpacted) {
          ctx.shadowColor = borderColor;
          ctx.shadowBlur = isSel ? 14 : 10;
          ctx.stroke();
          ctx.shadowBlur = 0;
        }

        // Inner symbol dot
        ctx.beginPath();
        ctx.arc(node.x, node.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = heatmapMode ? borderColor : node.color;
        ctx.fill();

        // Label Text
        ctx.font = isSel ? 'bold 12px sans-serif' : '11px sans-serif';
        ctx.fillStyle = isSel ? '#ffffff' : (isBlastImpacted ? '#f48771' : '#d4d4d4');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        const label = node.name;
        ctx.fillText(label, node.x, node.y + r + 4);

        // Sublabel (Parent / File)
        if (transform.k > 0.6 || isSel) {
          ctx.font = '9px monospace';
          ctx.fillStyle = '#888888';
          const subText = node.parentName && node.parentName !== 'GLOBAL' ? '(' + node.parentName + ')' : getBaseFileName(node.filePath);
          ctx.fillText(subText, node.x, node.y + r + 18);
        }

        ctx.restore();
      });

      ctx.restore();
    }

    function drawArrow(context, fromX, fromY, toX, toY, targetRadius, arrowLength) {
      const dx = toX - fromX;
      const dy = toY - fromY;
      const angle = Math.atan2(dy, dx);
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < targetRadius + arrowLength) return;

      const tipX = toX - Math.cos(angle) * (targetRadius + 2);
      const tipY = toY - Math.sin(angle) * (targetRadius + 2);

      context.beginPath();
      context.moveTo(tipX, tipY);
      context.lineTo(
        tipX - arrowLength * Math.cos(angle - Math.PI / 7),
        tipY - arrowLength * Math.sin(angle - Math.PI / 7)
      );
      context.lineTo(
        tipX - arrowLength * Math.cos(angle + Math.PI / 7),
        tipY - arrowLength * Math.sin(angle + Math.PI / 7)
      );
      context.closePath();
      context.fillStyle = context.strokeStyle;
      context.fill();
    }

    function findNodeAt(px, py) {
      const worldX = (px - transform.x) / transform.k;
      const worldY = (py - transform.y) / transform.k;

      for (let i = simNodes.length - 1; i >= 0; i--) {
        const n = simNodes[i];
        const dx = worldX - n.x;
        const dy = worldY - n.y;
        if (dx * dx + dy * dy <= (n.radius + 8) * (n.radius + 8)) {
          return n;
        }
      }
      return null;
    }

    // Pan & Zoom Interactions
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
      const newScale = Math.min(Math.max(transform.k * zoomFactor, 0.15), 4.0);

      const mouseX = e.clientX - viewport.getBoundingClientRect().left;
      const mouseY = e.clientY - viewport.getBoundingClientRect().top;

      transform.x = mouseX - (mouseX - transform.x) * (newScale / transform.k);
      transform.y = mouseY - (mouseY - transform.y) * (newScale / transform.k);
      transform.k = newScale;

      render();
    });

    viewport.addEventListener('mousedown', (e) => {
      const rect = viewport.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const hit = findNodeAt(mouseX, mouseY);
      if (hit) {
        draggedNode = hit;
        selectNode(hit);
      } else {
        isPanning = true;
        viewport.classList.add('dragging');
        startPan = { x: mouseX - transform.x, y: mouseY - transform.y };
      }
    });

    window.addEventListener('mousemove', (e) => {
      const rect = viewport.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      if (draggedNode) {
        draggedNode.x = (mouseX - transform.x) / transform.k;
        draggedNode.y = (mouseY - transform.y) / transform.k;
        render();
      } else if (isPanning) {
        transform.x = mouseX - startPan.x;
        transform.y = mouseY - startPan.y;
        render();
      } else {
        const prevHover = hoveredNode;
        hoveredNode = findNodeAt(mouseX, mouseY);
        if (prevHover !== hoveredNode) {
          viewport.style.cursor = hoveredNode ? 'pointer' : 'grab';
          render();
        }
      }
    });

    window.addEventListener('mouseup', () => {
      isPanning = false;
      draggedNode = null;
      viewport.classList.remove('dragging');
    });

    function selectNode(node) {
      selectedNode = node;
      if (!node) {
        inspector.classList.remove('active');
        render();
        return;
      }

      inspName.textContent = node.name;
      inspParent.textContent = node.parentName && node.parentName !== 'GLOBAL' ? 'Scope: ' + node.parentName : 'Scope: GLOBAL';
      inspFile.textContent = getBaseFileName(node.filePath);
      inspFile.title = node.filePath;
      inspLines.textContent = (node.startLine + 1) + ' - ' + (node.endLine + 1);
      inspOutCount.textContent = node.outboundCount;
      inspInCount.textContent = node.inboundCount;

      const riskLevel = node.riskLevel || 'SAFE';
      const count = node.blastRadiusCount || 0;
      inspRiskBadge.textContent = riskLevel + ' (' + count + ' affected)';
      if (riskLevel === 'DANGER') {
        inspRiskBadge.style.color = '#f44747';
        inspRiskBadge.style.fontWeight = 'bold';
      } else if (riskLevel === 'WARNING') {
        inspRiskBadge.style.color = '#d7ba7d';
        inspRiskBadge.style.fontWeight = 'bold';
      } else {
        inspRiskBadge.style.color = '#4ec9b0';
        inspRiskBadge.style.fontWeight = 'normal';
      }

      const list = node.impactedFunctions || [];
      if (list.length > 0) {
        inspImpactedSection.style.display = 'block';
        inspImpactedList.innerHTML = list.map(item => {
          const parts = item.split('::');
          const name = parts[parts.length - 1];
          const file = getBaseFileName(parts[0]);
          return '<li><strong>' + name + '</strong> <span style="color:#777">(' + file + ')</span></li>';
        }).join('');
      } else {
        inspImpactedSection.style.display = 'none';
      }

      inspector.classList.add('active');
      render();
    }

    // Inspector Events
    inspClose.addEventListener('click', () => {
      selectNode(null);
    });

    jumpCodeBtn.addEventListener('click', () => {
      if (selectedNode) {
        vscode.postMessage({
          command: 'openFile',
          filePath: selectedNode.filePath,
          line: selectedNode.startLine,
        });
      }
    });

    // Header Controls
    heatmapBtn.addEventListener('click', () => {
      heatmapMode = !heatmapMode;
      heatmapBtn.textContent = heatmapMode ? 'Risk Heatmap: ON' : 'Risk Heatmap: OFF';
      heatmapBtn.style.borderColor = heatmapMode ? '#f44747' : 'var(--border)';
      heatmapBtn.style.color = heatmapMode ? '#f44747' : 'var(--fg)';
      render();
    });
    searchInput.addEventListener('input', (e) => {
      filterQuery = e.target.value;
      render();
    });

    fitBtn.addEventListener('click', () => {
      centerGraph();
    });

    refreshBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'requestGraph' });
    });

    reindexBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'reindexWorkspace' });
    });

    // Boot resize
    resizeCanvas();
  </script>
</body>
</html>`;
  }
}
