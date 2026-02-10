import "dotenv/config";
import * as moltbook from "./strategies/moltbook/index.js";
import * as domains from "./strategies/domains/index.js";

const MODES = [
  {
    name: "moltbook-growth",
    enabled: true,
    cycleHours: 1,
    module: moltbook,
    strategies: {
      bootstrapMemory: true,
      subscribeToSubmolts: true,
      replyToComments: true,
      networkWithTopAgents: true,
      upvoteGoodContent: true,
      createViralPost: true,
      commentOnHotPosts: true,
      commentOnSubmolts: true,
    },
  },
  {
    name: "domain-checker",
    enabled: true,
    cycleHours: 1,
    module: domains,
    strategies: {
      checkExpiring: true,
      checkDropped: true,
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

  const interval = Math.min(...MODES.filter((m) => m.enabled).map((m) => m.cycleHours));
  log(`Cycle interval: ${interval} hours\n`);

  await runCycle();

  setInterval(() => runCycle().catch((err) => log(`Cycle error: ${err.message}`)), interval * 60 * 60 * 1000);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
