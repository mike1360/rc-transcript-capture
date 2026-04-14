const http = require("http");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

// Load .env file
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.+)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const PORT = process.argv[2] || 3099;
const CAPTURES_DIR = path.join(__dirname, "captures");
const API_KEY = process.env.ANTHROPIC_API_KEY;

const anthropic = new Anthropic({ apiKey: API_KEY });

// --- Auto-analysis state ---
let lastAnalyzedLineCount = 0;
let analysisResults = [];
let analysisInProgress = false;
const ANALYSIS_INTERVAL = 30000; // every 30 seconds
const ANALYSIS_MIN_NEW_LINES = 5; // need at least 5 new Q/A blocks

function getLatestCapture() {
  const files = fs
    .readdirSync(CAPTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(CAPTURES_DIR, files[0]) : null;
}

function parseSpecheSba(raw) {
  if (!raw || raw.length < 40) return [];
  let text = raw;
  const firstCtrl = text.indexOf("\x02");
  if (firstCtrl >= 0) {
    const segments = text.slice(firstCtrl).split("\x02");
    let fullText = "";
    for (const seg of segments) {
      if (seg.length < 2) continue;
      const content = seg.slice(1).replace(/\x03/g, "").trim();
      if (content) fullText += " " + content;
    }
    text = fullText.trim();
  } else {
    text = text.replace(/^[a-f0-9-]{36}/, "").trim();
  }
  if (!text) return [];
  const parts = text.split(
    /\s+(?=Q\.\s)|(?=\s+A\.\s)|(?=[A-Z][a-z]+ [A-Z][a-z]+ \([^)]+\)\s*:)/
  );
  return parts.map((p) => p.trim()).filter((p) => p.length > 2);
}

function loadCapture() {
  const file = getLatestCapture();
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    const hasLiveLines = (data.transcriptLines || []).some(
      (l) => l.source === "speche-iframe"
    );
    if (hasLiveLines) {
      const rawLines = (data.transcriptLines || [])
        .map((l) => (l.text || "").trim())
        .filter((t) => t.length > 0);
      const fullText = rawLines.join(" ").replace(/\s+/g, " ");
      const parts = fullText.split(
        /(?=\bQ\.\s)|(?=\bA\.\s)|(?=[A-Z][a-z]+ [A-Z][a-z]+ \([^)]+\)\s*:)/
      );
      data.transcriptLines = parts
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((text) => ({ source: "speche-iframe", text }));
      return data;
    }
    if (data.rawInterceptions) {
      data.transcriptLines = [];
      const sbaEntries = data.rawInterceptions.filter(
        (r) => r.url && r.url.includes(".sba") && r.body
      );
      for (const entry of sbaEntries) {
        const lines = parseSpecheSba(entry.body);
        for (const line of lines) {
          data.transcriptLines.push({
            time: entry.time,
            source: "speche-sba",
            text: line,
          });
        }
      }
    }
    return data;
  } catch {
    return null;
  }
}

function getTranscriptText(data) {
  if (!data || !data.transcriptLines) return "";
  return data.transcriptLines.map((l) => l.text || "").join("\n");
}

// --- Claude NLP Query ---
async function queryTranscript(question, transcriptText) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20241022",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You are a legal analyst reviewing a live deposition transcript. Answer the question concisely and cite specific testimony when relevant. If the transcript doesn't contain enough information, say so.

TRANSCRIPT:
${transcriptText.slice(-15000)}

QUESTION: ${question}`,
      },
    ],
  });
  return response.content[0].text;
}

// --- Auto-analysis for contradictions & suggested questions ---
async function analyzeTranscript(transcriptText, lineCount) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20241022",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: `You are a senior litigation attorney reviewing a live deposition transcript in real-time. Analyze the MOST RECENT portion of testimony and provide:

1. **Potential Contradictions**: Any statements that conflict with earlier testimony. Quote both statements.
2. **Suggested Follow-up Questions**: 3-5 sharp follow-up questions an attorney should ask based on what was just said. Focus on gaps, vague answers, or areas where the witness could be pinned down.
3. **Key Admissions**: Any significant concessions or admissions the witness made.
4. **Credibility Notes**: Anything that affects witness credibility (hedging, inconsistency, evasiveness).

Be specific. Quote the testimony. Be concise — this is a real-time tool.

TRANSCRIPT (most recent ~8000 chars shown):
${transcriptText.slice(-8000)}`,
      },
    ],
  });
  return response.content[0].text;
}

// Run auto-analysis periodically
setInterval(async () => {
  if (analysisInProgress) return;
  const data = loadCapture();
  if (!data) return;
  const lineCount = (data.transcriptLines || []).length;
  if (lineCount - lastAnalyzedLineCount < ANALYSIS_MIN_NEW_LINES) return;

  analysisInProgress = true;
  try {
    const text = getTranscriptText(data);
    console.log(
      `[Analysis] Running on ${lineCount} lines (${lineCount - lastAnalyzedLineCount} new)...`
    );
    const result = await analyzeTranscript(text, lineCount);
    analysisResults.unshift({
      time: new Date().toISOString(),
      lineCount,
      analysis: result,
    });
    // Keep last 20 analyses
    if (analysisResults.length > 20) analysisResults.length = 20;
    lastAnalyzedLineCount = lineCount;
    console.log("[Analysis] Complete.");
  } catch (e) {
    console.error("[Analysis] Error:", e.message);
  }
  analysisInProgress = false;
}, ANALYSIS_INTERVAL);

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>RC Transcript Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; background: #0a0a0f; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
  header { background: #12121a; border-bottom: 1px solid #2a2a3a; padding: 12px 20px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 16px; color: #7aa2f7; font-weight: 600; }
  .status { font-size: 12px; color: #9ece6a; display: flex; align-items: center; gap: 6px; }
  .status .dot { width: 8px; height: 8px; background: #9ece6a; border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .stats { font-size: 12px; color: #565f89; margin-left: auto; }
  .main { flex: 1; display: flex; overflow: hidden; }
  .transcript-panel { flex: 1; display: flex; flex-direction: column; border-right: 1px solid #2a2a3a; }
  .right-panel { width: 480px; display: flex; flex-direction: column; }
  .right-tabs { display: flex; background: #12121a; border-bottom: 1px solid #2a2a3a; }
  .right-tab { padding: 10px 16px; font-size: 12px; cursor: pointer; border-bottom: 2px solid transparent; color: #565f89; flex: 1; text-align: center; }
  .right-tab.active { color: #7aa2f7; border-bottom-color: #7aa2f7; }
  .right-tab:hover { color: #c0caf5; }
  .right-tab .badge { background: #f7768e; color: #1a1b26; font-size: 10px; padding: 1px 6px; border-radius: 8px; margin-left: 4px; }
  .panel-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .panel-body.hidden { display: none; }
  .query-input-area { padding: 12px; border-top: 1px solid #2a2a3a; background: #15151f; }
  .query-input-area input { width: 100%; padding: 10px 12px; background: #1a1b26; border: 1px solid #2a2a3a; border-radius: 6px; color: #c0caf5; font-family: inherit; font-size: 13px; outline: none; }
  .query-input-area input:focus { border-color: #7aa2f7; }
  .query-input-area input::placeholder { color: #565f89; }
  .transcript-body { flex: 1; overflow-y: auto; padding: 12px 16px; font-size: 13px; line-height: 1.7; }
  .transcript-body .line { padding: 2px 0; }
  .transcript-body .line .text { color: #c0caf5; }
  .transcript-body .line.speaker .text { color: #bb9af7; font-weight: 600; }
  .transcript-body .line.question .text { color: #7aa2f7; }
  .transcript-body .line.answer .text { color: #9ece6a; }
  .tab-bar { display: flex; gap: 0; background: #12121a; }
  .tab { padding: 8px 16px; font-size: 12px; cursor: pointer; border-bottom: 2px solid transparent; color: #565f89; }
  .tab.active { color: #7aa2f7; border-bottom-color: #7aa2f7; }
  .tab:hover { color: #c0caf5; }
  .hidden { display: none !important; }
  .empty { color: #565f89; font-style: italic; padding: 20px; text-align: center; }
  .query-result { margin-bottom: 16px; border-bottom: 1px solid #1a1b26; padding-bottom: 12px; }
  .query-result .q { color: #7aa2f7; font-size: 13px; margin-bottom: 8px; font-weight: 600; }
  .query-result .a { color: #c0caf5; font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
  .query-result .loading { color: #565f89; font-style: italic; }
  .analysis-card { background: #12121a; border: 1px solid #2a2a3a; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
  .analysis-card .time { color: #565f89; font-size: 11px; margin-bottom: 8px; }
  .analysis-card .content { font-size: 12px; line-height: 1.7; color: #c0caf5; white-space: pre-wrap; }
  .analysis-card .content strong { color: #f7768e; }
  .analysis-card h3 { color: #e0af68; font-size: 12px; margin: 10px 0 4px; }
  .network-log { font-size: 11px; color: #565f89; }
</style>
</head>
<body>

<header>
  <h1>RC Transcript Capture</h1>
  <div class="status"><div class="dot"></div> <span id="statusText">Connecting...</span></div>
  <div class="stats" id="stats"></div>
</header>

<div class="main">
  <div class="transcript-panel">
    <div class="tab-bar">
      <div class="tab active" data-tab="transcript">Transcript</div>
      <div class="tab" data-tab="network">Network</div>
      <div class="tab" data-tab="websocket">WebSocket</div>
      <div class="tab" data-tab="raw">Raw Data</div>
    </div>
    <div id="tab-transcript" class="transcript-body"></div>
    <div id="tab-network" class="transcript-body hidden"></div>
    <div id="tab-websocket" class="transcript-body hidden"></div>
    <div id="tab-raw" class="transcript-body hidden"></div>
  </div>

  <div class="right-panel">
    <div class="right-tabs">
      <div class="right-tab active" data-panel="ask">Ask Questions</div>
      <div class="right-tab" data-panel="analysis">AI Analysis <span class="badge" id="analysisBadge">0</span></div>
    </div>
    <div class="panel-body" id="panel-ask">
      <div class="empty">Ask anything about the deposition. Examples:<br><br>
        "What is this case about?"<br>
        "What did the witness say about maintenance?"<br>
        "Summarize the plaintiff's key claims"<br>
        "Any inconsistencies in the testimony?"
      </div>
    </div>
    <div class="panel-body hidden" id="panel-analysis">
      <div class="empty" id="analysisEmpty">Waiting for enough testimony to analyze...</div>
    </div>
    <div class="query-input-area">
      <input type="text" id="queryInput" placeholder="Ask about the deposition..." autofocus />
    </div>
  </div>
</div>

<script>
let data = null;

// Left tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.transcript-body').forEach(p => p.classList.add('hidden'));
    document.getElementById('tab-' + tab.dataset.tab).classList.remove('hidden');
  });
});

// Right tab switching
document.querySelectorAll('.right-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.right-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.panel-body').forEach(p => p.classList.add('hidden'));
    document.getElementById('panel-' + tab.dataset.panel).classList.remove('hidden');
  });
});

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function markdownToHtml(text) {
  let html = escapeHtml(text);
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^- (.+)$/gm, '\\u2022 $1');
  html = html.replace(/^\\d+\\. (.+)$/gm, '\\u2022 $1');
  return html;
}

function renderTranscript(lines) {
  if (!lines || lines.length === 0) return '<div class="empty">Waiting for transcript data...</div>';
  return lines.map(l => {
    const text = l.text || (l.data ? (typeof l.data === 'string' ? l.data : JSON.stringify(l.data)) : '');
    let cls = 'line';
    if (/^Q\\./.test(text)) cls += ' question';
    else if (/^A\\./.test(text)) cls += ' answer';
    else if (/^[A-Z][a-z]+ [A-Z]/.test(text) && text.includes(':')) cls += ' speaker';
    return '<div class="' + cls + '"><span class="text">' + escapeHtml(text) + '</span></div>';
  }).join('');
}

function renderNetwork(log) {
  const interesting = (log || []).filter(r =>
    r.category || r.url?.includes('speche') || r.url?.includes('Livetranscript') || r.url?.includes('pubnub')
  );
  if (interesting.length === 0) return '<div class="empty">No interesting network requests yet</div>';
  return '<div class="network-log">' + interesting.map(r => {
    const time = r.time ? new Date(r.time).toLocaleTimeString() : '';
    return '<div>[' + time + '] ' + (r.method||'') + ' ' + escapeHtml((r.url||'').slice(0,120)) + '</div>';
  }).join('') + '</div>';
}

function renderWebSocket(frames) {
  if (!frames || frames.length === 0) return '<div class="empty">No WebSocket frames yet</div>';
  return '<div class="network-log">' + frames.slice(-100).map(f => {
    const time = f.time ? new Date(f.time).toLocaleTimeString() : '';
    return '<div>[' + time + '] ' + f.event + ' ' + escapeHtml((f.payload||f.url||'').slice(0,200)) + '</div>';
  }).join('') + '</div>';
}

function renderRaw(items) {
  if (!items || items.length === 0) return '<div class="empty">No raw interceptions yet</div>';
  return '<div class="network-log">' + items.slice(-50).map(r => {
    const time = r.time ? new Date(r.time).toLocaleTimeString() : '';
    return '<div>[' + time + '] ' + escapeHtml((r.url||r.body||'').toString().slice(0,200)) + '</div>';
  }).join('') + '</div>';
}

// NLP Query handler
document.getElementById('queryInput').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  const query = e.target.value.trim();
  if (!query) return;
  e.target.value = '';

  // Switch to Ask tab
  document.querySelectorAll('.right-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-panel="ask"]').classList.add('active');
  document.querySelectorAll('.panel-body').forEach(p => p.classList.add('hidden'));
  document.getElementById('panel-ask').classList.remove('hidden');

  const panel = document.getElementById('panel-ask');
  const id = 'q-' + Date.now();
  panel.innerHTML = '<div class="query-result" id="' + id + '"><div class="q">' + escapeHtml(query) + '</div><div class="a loading">Analyzing transcript...</div></div>' + panel.innerHTML;

  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: query })
    });
    const result = await res.json();
    const el = document.getElementById(id);
    if (el) {
      el.querySelector('.a').className = 'a';
      el.querySelector('.a').innerHTML = markdownToHtml(result.answer);
    }
  } catch (err) {
    const el = document.getElementById(id);
    if (el) {
      el.querySelector('.a').innerHTML = '<span style="color:#f7768e">Error: ' + err.message + '</span>';
    }
  }
});

// Poll for updates
async function refresh() {
  try {
    const res = await fetch('/api/data');
    data = await res.json();
    document.getElementById('statusText').textContent =
      'Capturing \\u2014 ' + (data.transcriptLines?.length || 0) + ' lines';
    document.getElementById('stats').textContent =
      'Network: ' + (data.networkLog?.length || 0) +
      ' | WS: ' + (data.websocketFrames?.length || 0) +
      ' | PubNub: ' + (data.pubnubMessages?.length || 0);
    const transcriptEl = document.getElementById('tab-transcript');
    const wasAtBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 50;
    transcriptEl.innerHTML = renderTranscript(data.transcriptLines);
    if (wasAtBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
    document.getElementById('tab-network').innerHTML = renderNetwork(data.networkLog);
    document.getElementById('tab-websocket').innerHTML = renderWebSocket(data.websocketFrames);
    document.getElementById('tab-raw').innerHTML = renderRaw(data.rawInterceptions);
  } catch (err) {
    document.getElementById('statusText').textContent = 'Error: ' + err.message;
  }
}

// Poll for analysis results
async function refreshAnalysis() {
  try {
    const res = await fetch('/api/analysis');
    const results = await res.json();
    const badge = document.getElementById('analysisBadge');
    badge.textContent = results.length;
    if (results.length === 0) return;
    document.getElementById('analysisEmpty')?.remove();
    const panel = document.getElementById('panel-analysis');
    panel.innerHTML = results.map(r => {
      const time = new Date(r.time).toLocaleTimeString();
      return '<div class="analysis-card"><div class="time">' + time + ' \\u2014 ' + r.lineCount + ' lines analyzed</div><div class="content">' + markdownToHtml(r.analysis) + '</div></div>';
    }).join('');
  } catch {}
}

setInterval(refresh, 2000);
setInterval(refreshAnalysis, 5000);
refresh();
refreshAnalysis();
</script>
</body>
</html>`;

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  if (req.url === "/api/data") {
    const data = loadCapture();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data || { error: "No capture file found" }));
  } else if (req.url === "/api/query" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { question } = JSON.parse(body);
        const data = loadCapture();
        const text = getTranscriptText(data);
        console.log(`[Query] "${question}" (${text.length} chars of transcript)`);
        const answer = await queryTranscript(question, text);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answer }));
      } catch (e) {
        console.error("[Query] Error:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.url === "/api/analysis") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(analysisResults));
  } else {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log(`Reading captures from: ${CAPTURES_DIR}`);
  console.log(`Claude AI analysis enabled (every ${ANALYSIS_INTERVAL / 1000}s)`);
});
