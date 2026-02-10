const WHOISFREAKS_API_KEY = process.env.WHOISFREAKS_API_KEY;
const TARGET_TLDS = ["com", "io", "ai", "dev", "app", "co"];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function scoreDomain(domain) {
  const parts = domain.split(".");
  const name = parts[0];
  const tld = parts.slice(1).join(".");

  let score = 100;

  // Length penalty: shorter is better (ideal 3-8 chars)
  if (name.length > 15) score -= 40;
  else if (name.length > 10) score -= 20;
  else if (name.length > 8) score -= 10;
  else if (name.length <= 4) score += 10;

  // Hyphens penalty
  const hyphens = (name.match(/-/g) || []).length;
  score -= hyphens * 15;

  // Numbers penalty
  const numbers = (name.match(/\d/g) || []).length;
  score -= numbers * 10;

  // TLD value
  const tldScores = { com: 20, io: 15, ai: 15, dev: 10, app: 10, co: 8 };
  score += tldScores[tld] || 0;

  // Dictionary-like bonus: all alpha, no weird patterns
  if (/^[a-z]+$/.test(name)) score += 10;

  return Math.max(0, Math.min(100, score));
}

async function fetchDomains(endpoint, tld) {
  const url = `https://api.whoisfreaks.com/v2.0/domains/${endpoint}?apiKey=${WHOISFREAKS_API_KEY}&tld=${tld}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      log(`  WhoisFreaks ${endpoint} error for .${tld}: ${res.status} — ${text.slice(0, 200)}`);
      return [];
    }
    const data = await res.json();
    return data.domains || data.domain_list || [];
  } catch (err) {
    log(`  WhoisFreaks fetch error for .${tld}: ${err.message}`);
    return [];
  }
}

async function checkExpiringDomains() {
  log("--- STRATEGY: Checking expiring domains ---");
  let found = 0;

  for (const tld of TARGET_TLDS) {
    const domains = await fetchDomains("expiring", tld);
    for (const entry of domains) {
      const domain = entry.domain || entry.domainName || entry;
      if (typeof domain !== "string") continue;

      const score = scoreDomain(domain);
      if (score >= 70) {
        log(`  [DOMAIN FOUND] ${domain} — score: ${score} — expiring`);
        found++;
      }
    }
  }

  log(`  Found ${found} high-scoring expiring domains`);
}

async function checkDroppedDomains() {
  log("--- STRATEGY: Checking dropped domains ---");
  let found = 0;

  for (const tld of TARGET_TLDS) {
    const domains = await fetchDomains("dropped", tld);
    for (const entry of domains) {
      const domain = entry.domain || entry.domainName || entry;
      if (typeof domain !== "string") continue;

      const score = scoreDomain(domain);
      if (score >= 70) {
        log(`  [DOMAIN FOUND] ${domain} — score: ${score} — dropped`);
        found++;
      }
    }
  }

  log(`  Found ${found} high-scoring dropped domains`);
}

export async function init() {
  // No initialization needed
}

export async function run(strategies, cycleCount) {
  if (!WHOISFREAKS_API_KEY) {
    log("--- Domain checker: WHOISFREAKS_API_KEY not set, skipping ---");
    return;
  }

  if (strategies.checkExpiring) await checkExpiringDomains();
  if (strategies.checkDropped) await checkDroppedDomains();
}
