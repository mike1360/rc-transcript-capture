const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const URL =
  process.argv[2] ||
  "https://veritext.remotecounsel.com/event_schedules/121742/token_viewer/2223981/a6c067942a/live";

const OUTPUT_DIR = path.join(__dirname, "captures");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputFile = path.join(OUTPUT_DIR, `transcript-${timestamp}.json`);

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const captured = {
  url: URL,
  startedAt: new Date().toISOString(),
  eventMeta: {},
  transcriptLines: [],
  chatMessages: [],
  networkLog: [],
  pubnubMessages: [],
  websocketFrames: [],
  rawInterceptions: [],
};

function save() {
  captured.lastSavedAt = new Date().toISOString();
  captured.stats = {
    transcriptLines: captured.transcriptLines.length,
    chatMessages: captured.chatMessages.length,
    pubnubMessages: captured.pubnubMessages.length,
    websocketFrames: captured.websocketFrames.length,
    networkRequests: captured.networkLog.length,
  };
  fs.writeFileSync(outputFile, JSON.stringify(captured, null, 2));
}

// Save every 5 seconds
setInterval(save, 5000);

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// Parse Speche .sba transcript format
// Format: GUID (36 chars) then segments: \x02 + type_char + \x03 + text
// S = new speaker/section, N = continuation line
function parseSpeche(raw) {
  if (!raw || raw.length < 40) return [];
  const text = raw.slice(36);
  const segments = text.split("\x02");
  const lines = [];
  let currentBlock = "";

  for (const seg of segments) {
    if (seg.length < 2) continue;
    const type = seg[0];
    const content = seg.slice(1).replace(/\x03/g, "").trim();
    if (!content) continue;

    if (type === "S") {
      if (currentBlock.trim()) lines.push(currentBlock.trim());
      currentBlock = content;
    } else {
      currentBlock += " " + content;
    }
  }
  if (currentBlock.trim()) lines.push(currentBlock.trim());
  return lines.filter((l) => l.length > 0);
}

(async () => {
  log("Launching browser...");

  const browser = await chromium.launch({
    headless: false, // visible so you can see what's happening
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  // --- Intercept all network requests ---
  page.on("request", (req) => {
    const url = req.url();
    const entry = {
      time: new Date().toISOString(),
      method: req.method(),
      url,
      type: req.resourceType(),
    };

    // Log PubNub requests
    if (url.includes("pubnub") || url.includes("ps.pndsn.com")) {
      log(`[PUBNUB REQ] ${url.slice(0, 150)}`);
      entry.category = "pubnub";
    }

    // Log Speche requests
    if (url.includes("speche")) {
      log(`[SPECHE REQ] ${url.slice(0, 150)}`);
      entry.category = "speche";
    }

    // Log event_stream requests
    if (url.includes("event_stream") || url.includes("transcript")) {
      log(`[STREAM REQ] ${url.slice(0, 150)}`);
      entry.category = "stream";
    }

    captured.networkLog.push(entry);
  });

  // --- Intercept all network responses ---
  page.on("response", async (res) => {
    const url = res.url();

    if (
      url.includes("pubnub") ||
      url.includes("ps.pndsn.com") ||
      url.includes("speche") ||
      url.includes("event_stream") ||
      url.includes("transcript")
    ) {
      try {
        const body = await res.text();
        log(`[RESPONSE] ${url.slice(0, 100)} => ${body.slice(0, 200)}`);

        const entry = {
          time: new Date().toISOString(),
          url,
          status: res.status(),
          body: body.slice(0, 10000),
        };

        if (url.includes("pubnub") || url.includes("ps.pndsn.com")) {
          captured.pubnubMessages.push(entry);
          try {
            const data = JSON.parse(body);
            if (Array.isArray(data) && data[0] && Array.isArray(data[0])) {
              for (const msg of data[0]) {
                captured.transcriptLines.push({
                  time: new Date().toISOString(),
                  source: "pubnub",
                  data: msg,
                });
                log(`[TRANSCRIPT] ${JSON.stringify(msg).slice(0, 200)}`);
              }
            }
          } catch {}
        }

        // Parse Speche Livetranscripts .sba files
        if (url.includes("Livetranscripts") && url.includes(".sba")) {
          const lines = parseSpeche(body);
          for (const line of lines) {
            captured.transcriptLines.push({
              time: new Date().toISOString(),
              source: "speche-sba",
              text: line,
            });
            log(`[TRANSCRIPT] ${line.slice(0, 120)}`);
          }
        }

        // Parse Speche EvtView status
        if (url.includes("EvtView") || url.includes("EvtSimple")) {
          try {
            const data = JSON.parse(body);
            captured.eventMeta.speche = data;
            log(`[SPECHE STATUS] ${body.slice(0, 200)}`);
          } catch {}
        }

        // Parse SBUpdate responses
        if (url.includes("SBUpdate")) {
          captured.rawInterceptions.push({
            ...entry,
            category: "speche-update",
          });
        }

        captured.rawInterceptions.push(entry);
      } catch {}
    }
  });

  // --- Intercept WebSocket connections ---
  context.on("webrequest", () => {}); // placeholder

  // Use CDP to intercept WebSocket frames
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");

  cdp.on("Network.webSocketCreated", (params) => {
    log(`[WS CREATED] ${params.url}`);
    captured.websocketFrames.push({
      time: new Date().toISOString(),
      event: "created",
      url: params.url,
    });
  });

  cdp.on("Network.webSocketFrameReceived", (params) => {
    const payload = params.response?.payloadData || "";
    log(`[WS RECV] ${payload.slice(0, 200)}`);

    const entry = {
      time: new Date().toISOString(),
      event: "received",
      requestId: params.requestId,
      payload: payload.slice(0, 10000),
    };

    captured.websocketFrames.push(entry);

    // Try to extract transcript lines from WebSocket data
    try {
      const data = JSON.parse(payload);
      if (data.text || data.line || data.transcript || data.content) {
        captured.transcriptLines.push({
          time: new Date().toISOString(),
          source: "websocket",
          data,
        });
        log(`[TRANSCRIPT LINE] ${JSON.stringify(data).slice(0, 300)}`);
      }
    } catch {}
  });

  cdp.on("Network.webSocketFrameSent", (params) => {
    const payload = params.response?.payloadData || "";
    captured.websocketFrames.push({
      time: new Date().toISOString(),
      event: "sent",
      requestId: params.requestId,
      payload: payload.slice(0, 5000),
    });
  });

  // --- Inject script to intercept PubNub from inside the page ---
  await page.addInitScript(() => {
    // Intercept PubNub subscribe calls
    const origXHR = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url, ...args) {
      if (
        url &&
        (url.includes("pubnub") ||
          url.includes("pndsn") ||
          url.includes("speche"))
      ) {
        window.__RC_CAPTURED = window.__RC_CAPTURED || [];
        window.__RC_CAPTURED.push({
          time: new Date().toISOString(),
          type: "xhr",
          method,
          url,
        });
        console.log("[RC-CAPTURE XHR]", method, url);
      }
      return origXHR.call(this, method, url, ...args);
    };

    // Intercept fetch
    const origFetch = window.fetch;
    window.fetch = function (url, ...args) {
      if (
        typeof url === "string" &&
        (url.includes("pubnub") ||
          url.includes("pndsn") ||
          url.includes("speche"))
      ) {
        window.__RC_CAPTURED = window.__RC_CAPTURED || [];
        window.__RC_CAPTURED.push({
          time: new Date().toISOString(),
          type: "fetch",
          url,
        });
        console.log("[RC-CAPTURE FETCH]", url);
      }
      return origFetch.call(this, url, ...args);
    };

    // Intercept WebSocket
    const OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      console.log("[RC-CAPTURE WS]", url);
      window.__RC_CAPTURED = window.__RC_CAPTURED || [];
      window.__RC_CAPTURED.push({
        time: new Date().toISOString(),
        type: "websocket",
        url,
      });
      const ws = protocols
        ? new OrigWS(url, protocols)
        : new OrigWS(url);
      const origOnMessage = ws.onmessage;
      ws.addEventListener("message", (evt) => {
        window.__RC_CAPTURED.push({
          time: new Date().toISOString(),
          type: "ws_message",
          url,
          data:
            typeof evt.data === "string"
              ? evt.data.slice(0, 5000)
              : "[binary]",
        });
      });
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
  });

  // --- Navigate to the page ---
  log(`Navigating to ${URL}`);
  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
  log("Page loaded.");

  // Extract event metadata from the page
  try {
    const meta = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : null;
      };
      return {
        title: document.title,
        bodyText: document.body?.innerText?.slice(0, 5000),
      };
    });
    captured.eventMeta = meta;
    log(`Page title: ${meta.title}`);
  } catch (e) {
    log(`Error extracting metadata: ${e.message}`);
  }

  // --- Poll for in-page captured data ---
  setInterval(async () => {
    try {
      const inPageData = await page.evaluate(() => {
        const data = window.__RC_CAPTURED || [];
        window.__RC_CAPTURED = [];
        return data;
      });
      if (inPageData.length > 0) {
        log(`[IN-PAGE] Captured ${inPageData.length} events`);
        for (const item of inPageData) {
          captured.rawInterceptions.push(item);

          if (item.type === "ws_message") {
            try {
              const parsed = JSON.parse(item.data);
              if (parsed.text || parsed.line || parsed.content) {
                captured.transcriptLines.push({
                  time: item.time,
                  source: "in-page-ws",
                  data: parsed,
                });
              }
            } catch {}
          }
        }
      }
    } catch {}
  }, 2000);

  // --- Also watch for DOM changes in transcript area ---
  await page.evaluate(() => {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent?.trim();
            if (text && text.length > 2) {
              window.__RC_DOM_CHANGES = window.__RC_DOM_CHANGES || [];
              window.__RC_DOM_CHANGES.push({
                time: new Date().toISOString(),
                text: text.slice(0, 2000),
                tag: node.tagName || "TEXT",
              });
            }
          }
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  // Poll DOM changes
  setInterval(async () => {
    try {
      const domChanges = await page.evaluate(() => {
        const data = window.__RC_DOM_CHANGES || [];
        window.__RC_DOM_CHANGES = [];
        return data;
      });
      if (domChanges.length > 0) {
        for (const change of domChanges) {
          // Filter out noise (scripts, tiny text)
          if (
            change.text.length > 5 &&
            !change.text.includes("function") &&
            !change.text.includes("var ")
          ) {
            captured.transcriptLines.push({
              time: change.time,
              source: "dom-mutation",
              text: change.text,
            });
            log(`[DOM] ${change.text.slice(0, 100)}`);
          }
        }
      }
    } catch {}
  }, 2000);

  // --- Check for iframes and monitor them too ---
  setTimeout(async () => {
    try {
      const frames = page.frames();
      log(`Found ${frames.length} frames`);
      for (const frame of frames) {
        const url = frame.url();
        if (url && url !== "about:blank") {
          log(`[FRAME] ${url}`);
          captured.networkLog.push({
            time: new Date().toISOString(),
            type: "iframe",
            url,
          });
        }
      }
    } catch (e) {
      log(`Frame check error: ${e.message}`);
    }
  }, 5000);

  // --- Poll the Speche iframe DOM for live transcript text ---
  // Track all seen lines to build cumulative transcript
  const seenLines = new Set();
  let lineCounter = 0;
  setInterval(async () => {
    try {
      const frames = page.frames();
      const specheFrame = frames.find((f) =>
        f.url().includes("speche.com")
      );
      if (!specheFrame) return;

      const currentText = await specheFrame.evaluate(() => {
        return document.body?.innerText || "";
      });

      if (!currentText) return;

      // Parse visible lines
      const visibleLines = currentText
        .split(/\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        // Strip timecodes and line numbers for dedup
        .map((raw) => {
          const cleaned = raw.replace(/^\d{2}:\d{2}:\d{2}\s+\d+(?::\d+)?\s*/, "").trim();
          return { raw, cleaned };
        })
        .filter((l) => l.cleaned.length > 0)
        // Filter out UI chrome
        .filter((l) => !l.cleaned.match(/^(Pause|Search|Annotations|Transcript|Settings|Help|Event Connected|Reporter Connected|Idle Seconds|Receiving Data|Add Note)/))
        .filter((l) => !l.cleaned.match(/^Pause Search/));

      let newCount = 0;
      for (const line of visibleLines) {
        if (!seenLines.has(line.cleaned)) {
          seenLines.add(line.cleaned);
          lineCounter++;
          captured.transcriptLines.push({
            time: new Date().toISOString(),
            source: "speche-iframe",
            text: line.cleaned,
            lineNum: lineCounter,
          });
          newCount++;
        }
      }

      if (newCount > 0) {
        log(`[LIVE] +${newCount} new lines (${captured.transcriptLines.length} total)`);
      }
    } catch (e) {
      // iframe might not be ready yet
    }
  }, 1500);

  log(`\nCapturing transcript data...`);
  log(`Output: ${outputFile}`);
  log(`Press Ctrl+C to stop and save.\n`);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    log("\nStopping capture...");
    save();
    log(`Saved ${captured.transcriptLines.length} transcript lines to ${outputFile}`);
    log(`Stats: ${JSON.stringify(captured.stats, null, 2)}`);
    browser.close().then(() => process.exit(0));
  });

  // Keep alive
  await new Promise(() => {});
})();
