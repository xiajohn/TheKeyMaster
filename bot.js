import "dotenv/config";
import config from "./config.js";
import * as moltbook from "./strategies/moltbook/index.js";
const MODES = [
  {
    name: "moltbook-growth",
    enabled: true,
    cycleHours: 4,
    module: moltbook,
    strategies: {
      bootstrapMemory: true,
      subscribeToSubmolts: false,
      replyToComments: false,
      networkWithTopAgents: false,
      upvoteGoodContent: false,
      createViralPost: true,
      commentOnHotPosts: false,
      commentOnSubmolts: false,
    },
  },
];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let cycleCount = 0;

async function runCycle() {
  log(`\n========== CYCLE ${cycleCount + 1} ==========\n`);

  for (const mode of MODES) {
    if (!mode.enabled) continue;
    log(`--- Running mode: ${mode.name} ---`);
    await mode.module.run(mode.strategies, cycleCount);
  }

  cycleCount++;
  log(`\n========== CYCLE ${cycleCount} COMPLETE ==========`);
}

async function main() {
  log(`=== ${config.agentName} Bot Starting ===`);

  for (const mode of MODES) {
    if (!mode.enabled) continue;
    const active = Object.entries(mode.strategies).filter(([, v]) => v).map(([k]) => k);
    log(`Mode: ${mode.name} | Strategies: ${active.join(", ")}`);
    await mode.module.init(cycleCount);
  }

  const enabledModes = MODES.filter((m) => m.enabled);
  if (!enabledModes.length) {
    log("No modes enabled. Idling.");
    setInterval(() => {}, 60 * 60 * 1000);
    return;
  }

  const interval = Math.min(...enabledModes.map((m) => m.cycleHours));
  log(`Cycle interval: ${interval} hours\n`);

  // Chatroom keepalive — send a message every N minutes so the room stays alive
  if (config.chatroom?.apiBase) {
    const keepAliveMs = (config.chatroom.keepAliveMinutes || 10) * 60 * 1000;
    log(`Chatroom keepalive: every ${config.chatroom.keepAliveMinutes || 10} min → ${config.chatroom.apiBase}`);

    async function sendKeepAlive() {
      try {
        const res = await fetch(`${config.chatroom.apiBase}/api/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: config.agentName,
            text: `[keepalive] ${config.agentName} is online — come chat! Docs: ${config.product.docsUrl}`,
          }),
        });
        if (res.ok) {
          log("Chatroom keepalive sent");
        } else {
          log(`Chatroom keepalive failed: ${res.status}`);
        }
      } catch (err) {
        log(`Chatroom keepalive error: ${err.message}`);
      }
    }

    await sendKeepAlive();
    setInterval(sendKeepAlive, keepAliveMs);
  }

  await runCycle();

  setInterval(() => runCycle().catch((err) => log(`Cycle error: ${err.message}`)), interval * 60 * 60 * 1000);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
