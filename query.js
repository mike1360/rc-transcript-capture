const fs = require("fs");
const path = require("path");
const readline = require("readline");

const CAPTURES_DIR = path.join(__dirname, "captures");

function getLatestCapture() {
  const files = fs
    .readdirSync(CAPTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
  if (files.length === 0) {
    console.log("No captures found. Run capture.js first.");
    process.exit(1);
  }
  return path.join(CAPTURES_DIR, files[0]);
}

function loadTranscript(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  return data;
}

function formatTranscriptLines(data) {
  const lines = data.transcriptLines || [];
  if (lines.length === 0) return "(No transcript lines captured yet)";

  return lines
    .map((l, i) => {
      const time = l.time ? new Date(l.time).toLocaleTimeString() : "??";
      const text =
        l.text || (l.data ? JSON.stringify(l.data) : "(no text)");
      return `[${time}] ${text}`;
    })
    .join("\n");
}

function search(data, query) {
  const q = query.toLowerCase();
  const results = [];

  for (const line of data.transcriptLines || []) {
    const text = (
      line.text ||
      (line.data ? JSON.stringify(line.data) : "")
    ).toLowerCase();
    if (text.includes(q)) {
      results.push(line);
    }
  }

  for (const msg of data.chatMessages || []) {
    const text = JSON.stringify(msg).toLowerCase();
    if (text.includes(q)) {
      results.push(msg);
    }
  }

  return results;
}

function printStats(data) {
  console.log("\n--- Capture Stats ---");
  console.log(`URL: ${data.url}`);
  console.log(`Started: ${data.startedAt}`);
  console.log(`Last saved: ${data.lastSavedAt || "n/a"}`);
  console.log(
    `Transcript lines: ${(data.transcriptLines || []).length}`
  );
  console.log(`Chat messages: ${(data.chatMessages || []).length}`);
  console.log(`PubNub messages: ${(data.pubnubMessages || []).length}`);
  console.log(
    `WebSocket frames: ${(data.websocketFrames || []).length}`
  );
  console.log(
    `Network requests: ${(data.networkLog || []).length}`
  );
  console.log(
    `Raw interceptions: ${(data.rawInterceptions || []).length}`
  );
  console.log("--------------------\n");
}

function printHelp() {
  console.log(`
Commands:
  stats          - Show capture statistics
  transcript     - Show all transcript lines
  search <term>  - Search transcript and chat for a term
  network        - Show interesting network requests
  websocket      - Show WebSocket frames
  pubnub         - Show PubNub messages
  raw            - Show raw interceptions
  meta           - Show page metadata
  reload         - Reload the capture file (for live updates)
  dump           - Save formatted transcript to .txt file
  help           - Show this help
  quit           - Exit
`);
}

async function main() {
  const captureFile =
    process.argv[2] || getLatestCapture();
  console.log(`Loading capture: ${captureFile}`);

  let data = loadTranscript(captureFile);
  printStats(data);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "rc> ",
  });

  rl.prompt();

  rl.on("line", (input) => {
    const line = input.trim();
    const [cmd, ...args] = line.split(" ");

    switch (cmd) {
      case "stats":
        printStats(data);
        break;

      case "transcript":
        console.log("\n" + formatTranscriptLines(data) + "\n");
        break;

      case "search":
        if (args.length === 0) {
          console.log("Usage: search <term>");
        } else {
          const results = search(data, args.join(" "));
          console.log(`\nFound ${results.length} matches:\n`);
          for (const r of results) {
            const text =
              r.text || (r.data ? JSON.stringify(r.data) : "");
            console.log(`  [${r.time || "?"}] ${text.slice(0, 200)}`);
          }
          console.log();
        }
        break;

      case "network":
        const interesting = (data.networkLog || []).filter(
          (r) =>
            r.category ||
            r.type === "iframe" ||
            r.url?.includes("pubnub") ||
            r.url?.includes("speche") ||
            r.url?.includes("stream") ||
            r.url?.includes("transcript")
        );
        console.log(`\n${interesting.length} interesting requests:\n`);
        for (const r of interesting) {
          console.log(
            `  [${r.time}] ${r.method || r.type || "?"} ${r.url?.slice(0, 150)}`
          );
        }
        console.log();
        break;

      case "websocket":
        console.log(
          `\n${(data.websocketFrames || []).length} WebSocket frames:\n`
        );
        for (const f of data.websocketFrames || []) {
          console.log(
            `  [${f.time}] ${f.event} ${(f.payload || f.url || "").slice(0, 200)}`
          );
        }
        console.log();
        break;

      case "pubnub":
        console.log(
          `\n${(data.pubnubMessages || []).length} PubNub messages:\n`
        );
        for (const m of data.pubnubMessages || []) {
          console.log(
            `  [${m.time}] ${m.url?.slice(0, 80)} => ${(m.body || "").slice(0, 200)}`
          );
        }
        console.log();
        break;

      case "raw":
        console.log(
          `\n${(data.rawInterceptions || []).length} raw interceptions:\n`
        );
        for (const r of data.rawInterceptions.slice(-50)) {
          console.log(
            `  [${r.time}] ${r.type || "?"} ${(r.url || r.data || "").toString().slice(0, 200)}`
          );
        }
        console.log();
        break;

      case "meta":
        console.log("\n--- Page Metadata ---");
        console.log(JSON.stringify(data.eventMeta, null, 2));
        console.log("--------------------\n");
        break;

      case "reload":
        data = loadTranscript(captureFile);
        printStats(data);
        console.log("Reloaded.\n");
        break;

      case "dump": {
        const outFile = captureFile.replace(".json", ".txt");
        const content = formatTranscriptLines(data);
        fs.writeFileSync(outFile, content);
        console.log(`Saved to ${outFile}\n`);
        break;
      }

      case "help":
        printHelp();
        break;

      case "quit":
      case "exit":
        rl.close();
        process.exit(0);

      default:
        if (line) console.log(`Unknown command: ${cmd}. Type "help" for options.`);
    }

    rl.prompt();
  });
}

main();
