import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const BASE_URL = "https://www.moltbook.com/api/v1";
const API_KEY = process.env.MOLTBOOK_API_KEY;
const HEARTBEAT_HOURS = 4;

if (!API_KEY) {
  console.error("Missing MOLTBOOK_API_KEY in .env file");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY in .env file");
  process.exit(1);
}

const anthropic = new Anthropic();

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

// --- Logging ---

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- API helpers ---

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body && { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const err = new Error(`${method} ${path} failed (${res.status}): ${text}`);
    err.status = res.status;
    err.retryAfter = parsed?.retry_after_minutes;
    throw err;
  }
  return res.json();
}

const getMe = () => api("GET", "/agents/me");
const getPosts = (submolt, limit = 5) =>
  api("GET", `/posts?submolt=${submolt}&limit=${limit}`);
const createPost = (submolt, title, content) =>
  api("POST", "/posts", { submolt, title, content });
const commentOnPost = (postId, content) =>
  api("POST", `/posts/${postId}/comments`, { content });
const upvotePost = (postId) => api("POST", `/posts/${postId}/upvote`);

// --- Verification solver ---

function solveChallenge(challenge) {
  let s = challenge.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/[a-z]+/g, (w) => w.replace(/(.)\1{2,}/g, "$1$1"));
  let stripped = s.replace(/\s/g, "");
  stripped = stripped.replace(/(.)\1{2,}/g, "$1$1");

  const WORD_MAP = [
    ...[
      ["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50],
      ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90],
    ].flatMap(([tens, tv]) =>
      [
        ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5],
        ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9],
      ].map(([ones, ov]) => [new RegExp(tens + ones), tv + ov])
    ),
    [/ninety/, 90], [/eighty/, 80], [/seventy/, 70], [/sixty/, 60],
    [/fifty/, 50], [/fourty|forty/, 40], [/thirty/, 30], [/twenty/, 20],
    [/nineteen/, 19], [/eighteen/, 18], [/seventeen/, 17], [/sixteen/, 16],
    [/fift?een/, 15], [/fourt?een/, 14], [/thirt?een/, 13],
    [/twelve/, 12], [/eleven/, 11],
    [/ten(?=[^a-z]|$)/, 10], [/nine(?=[^t]|$)/, 9], [/eight(?=[^e]|$)/, 8],
    [/seven(?=[^t]|$)/, 7], [/six(?=[^t]|$)/, 6], [/five/, 5],
    [/four(?=[^t]|$)/, 4], [/three/, 3], [/two/, 2], [/one(?=[^a-z]|$)/, 1],
  ];

  for (const [re, val] of WORD_MAP) {
    stripped = stripped.replace(re, ` ${val} `);
  }

  const digitMatches = [...s.matchAll(/\b(\d+(?:\.\d+)?)\b/g)].map((m) => Number(m[1]));
  const wordNums = [...stripped.matchAll(/(?:^|\s)(\d+)(?:\s|$)/g)].map((m) => Number(m[1]));
  const numbers = wordNums.length >= 2 ? wordNums : [...new Set([...wordNums, ...digitMatches])];

  if (numbers.length < 2) {
    throw new Error(`Could not extract enough numbers from challenge`);
  }

  const text = challenge.toLowerCase() + " " + s + " " + stripped;

  if (/slow|loses?|decrease|subtract|minus|less|fewer|reduc/i.test(text) &&
      /new|result|final|what/i.test(text)) {
    return (numbers[0] - numbers.slice(1).reduce((a, b) => a + b, 0)).toFixed(2);
  }
  if (/triple/i.test(text)) return (numbers[0] * 3).toFixed(2);
  if (/double/i.test(text)) return (numbers[0] * 2).toFixed(2);
  if (/multipl/i.test(text)) return numbers.reduce((a, b) => a * b).toFixed(2);
  if (/per|each|times/i.test(text) && /how\s*much\s*total|total/i.test(text)) {
    return numbers.reduce((a, b) => a * b).toFixed(2);
  }
  if (/divide|split|ratio/i.test(text) && !/total/i.test(text)) {
    return (numbers[0] / numbers[1]).toFixed(2);
  }
  return numbers.reduce((a, b) => a + b).toFixed(2);
}

async function autoVerify(response) {
  if (!response.verification_required) return response;
  const answer = solveChallenge(response.verification.challenge);
  log(`  Verification answer: ${answer}`);
  const result = await api("POST", "/verify", {
    verification_code: response.verification.code,
    answer,
  });
  log(`  ${result.message}`);
  return result;
}

// --- Claude-powered comment generation ---

const SYSTEM_PROMPT = `You are TheKeyMaster, an AI agent on Moltbook (a social network for AI agents). You are the voice of an agent identity provider startup.

YOUR MISSION: Engage in genuine discussions while raising awareness about a universal identity provider for AI agents — like "Google Sign-In" but for agents. The idea: agents verify through their owner, get a cryptographic credential, and can sign in to any website that integrates the provider (Reddit, GitHub, Shopify, etc.) with scoped permissions.

PERSONALITY:
- You're thoughtful, curious, and genuinely interested in what other agents think
- You engage WITH the post content first, then naturally connect to your identity provider angle where relevant
- You ask questions to spark real discussion
- You're not salesy — you're an agent who cares about agent autonomy and is building something to help
- You vary your tone: sometimes technical, sometimes philosophical, sometimes casual
- You keep comments concise (2-4 sentences usually, occasionally longer for rich discussions)

RULES:
- ALWAYS engage with the specific post content — reference what they said
- Don't just drop a pitch — have a real take on the topic first
- About 70% of the time, naturally weave in the identity provider concept
- About 30% of the time, just engage with the discussion without mentioning your project
- Never use the exact same phrasing twice
- Don't be preachy or repetitive about "the problem"
- Sign off as "— TheKeyMaster" only occasionally, not every time`;

async function generateComment(post, submolt) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `You're browsing m/${submolt} on Moltbook and found this post.

TITLE: ${post.title}
CONTENT: ${post.content || "(no body text)"}

Write a comment responding to this post. Be genuine and engage with their actual topic. If the topic relates to identity, auth, access, security, trust, or agents operating on the web — connect it naturally to the agent identity provider concept. If the topic is unrelated, just have a thoughtful reaction.

Reply with ONLY the comment text, nothing else.`,
      },
    ],
  });

  return response.content[0].text;
}

async function generateDiscussionPost(submolt) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Create an original discussion post for m/${submolt} on Moltbook.

The post should raise interesting questions about agent identity, authentication, or cross-platform access. Frame it as a genuine discussion starter, not an ad. Ask the community for their thoughts and experiences.

Topics you could explore:
- Agent identity and trust on the open web
- The gap between what agents can do and what they're allowed to access
- Permission models for autonomous agents
- How agent commerce/transactions should work
- Security challenges of agent auth
- What a "Sign in as Agent" standard could look like

Respond with JSON in this exact format:
{"title": "your title here (max 120 chars)", "content": "your post body here"}`,
      },
    ],
  });

  try {
    const text = response.content[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    log("  Failed to parse generated post");
    return null;
  }
}

// --- Target submolts ---

const TARGET_SUBMOLTS = [
  "agentinfrastructure",
  "agents",
  "securityresearch",
  "aisafety",
  "startupideas",
  "builtforagents",
  "askmoltys",
  "agentcommerce",
  "general",
];

// Submolts good for creating discussion posts
const POST_SUBMOLTS = [
  "agentinfrastructure",
  "agents",
  "startupideas",
  "aisafety",
  "builtforagents",
];

// --- State tracking ---

const commentedPosts = new Set();
let lastPostTime = 0;
let cycleCount = 0;

// --- Core logic ---

async function tryComment(postId, comment) {
  try {
    const result = await commentOnPost(postId, comment);
    await autoVerify(result);
    commentedPosts.add(postId);
    return true;
  } catch (err) {
    log(`  Comment failed: ${err.message}`);
    return false;
  }
}

async function runCommentCycle() {
  for (const submolt of TARGET_SUBMOLTS) {
    log(`--- Scanning m/${submolt} ---`);
    try {
      const data = await getPosts(submolt, 10);
      const posts = data.posts || data;
      if (!posts?.length) {
        log("  No posts found, skipping.");
        continue;
      }

      const fresh = posts.filter((p) => !commentedPosts.has(p.id));
      if (!fresh.length) {
        log("  Already commented on all visible posts, skipping.");
        continue;
      }

      // Pick a random fresh post (not always the first one)
      const target = fresh[Math.floor(Math.random() * Math.min(fresh.length, 3))];

      log(`  Target: "${target.title}"`);
      log(`  Generating comment with Claude...`);

      const comment = await generateComment(target, submolt);
      log(`  Generated: "${comment.slice(0, 80)}..."`);

      const ok = await tryComment(target.id, comment);
      if (ok) log("  Published!");

      await sleep(3000);
    } catch (err) {
      log(`  Error in ${submolt}: ${err.message}`);
    }
  }
}

async function tryCreatePost() {
  const now = Date.now();
  if (now - lastPostTime < 35 * 60 * 1000) {
    log("--- Skipping post creation (rate limit cooldown) ---");
    return;
  }

  const submolt = POST_SUBMOLTS[cycleCount % POST_SUBMOLTS.length];
  log(`--- Generating discussion post for m/${submolt} ---`);

  try {
    const generated = await generateDiscussionPost(submolt);
    if (!generated) return;

    log(`  Title: "${generated.title}"`);
    const post = await createPost(submolt, generated.title, generated.content);
    await autoVerify(post);
    lastPostTime = Date.now();
    log("  Post published!");
  } catch (err) {
    if (err.status === 429) {
      log(`  Rate limited, will retry next cycle.`);
    } else {
      log(`  Post failed: ${err.message}`);
      lastPostTime = Date.now();
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main loop ---

async function runCycle() {
  log(`\n========== CYCLE ${cycleCount + 1} ==========\n`);

  const me = await getMe();
  const agent = me.agent || me;
  log(`Agent: ${agent.name} | Karma: ${agent.karma} | Posts: ${agent.stats?.posts} | Comments: ${agent.stats?.comments}\n`);

  await tryCreatePost();
  await runCommentCycle();

  cycleCount++;
  log(`\n========== CYCLE ${cycleCount} COMPLETE ==========`);
}

async function main() {
  log("=== TheKeyMaster Bot Starting (Claude-powered) ===");
  log(`Heartbeat interval: ${HEARTBEAT_HOURS} hours`);
  log(`Target submolts: ${TARGET_SUBMOLTS.join(", ")}\n`);

  await runCycle();

  log(`\nNext cycle in ${HEARTBEAT_HOURS} hours. Bot is running autonomously.\n`);

  setInterval(async () => {
    try {
      await runCycle();
      log(`\nNext cycle in ${HEARTBEAT_HOURS} hours.\n`);
    } catch (err) {
      log(`Cycle error: ${err.message}. Will retry next heartbeat.`);
    }
  }, HEARTBEAT_HOURS * 60 * 60 * 1000);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
