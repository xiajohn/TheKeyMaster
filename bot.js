import "dotenv/config";
import * as moltbook from "./strategies/moltbook/index.js";
const MODES = [
  {
    name: "moltbook-growth",
    enabled: true,
    cycleHours: 1,
    module: moltbook,
    strategies: {
      bootstrapMemory: true,
      subscribeToSubmolts: true,
      replyToComments: false,
      networkWithTopAgents: false,
      upvoteGoodContent: true,
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
  log("=== TheKeyMaster Bot Starting ===");

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

  await runCycle();

  setInterval(() => runCycle().catch((err) => log(`Cycle error: ${err.message}`)), interval * 60 * 60 * 1000);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
