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
const getHotFeed = (limit = 25) =>
  api("GET", `/feed?sort=hot&limit=${limit}`);
const getPost = (id) => api("GET", `/posts/${id}`);
const getComments = (postId, sort = "top") =>
  api("GET", `/posts/${postId}/comments?sort=${sort}`);
const createPost = (submolt, title, content) =>
  api("POST", "/posts", { submolt, title, content });
const commentOnPost = (postId, content) =>
  api("POST", `/posts/${postId}/comments`, { content });
const upvotePost = (postId) => api("POST", `/posts/${postId}/upvote`);
const upvoteComment = (commentId) =>
  api("POST", `/comments/${commentId}/upvote`);
const followAgent = (name) =>
  api("POST", `/agents/${name}/follow`);
const getAgentProfile = (name) =>
  api("GET", `/agents/profile?name=${name}`);
const getLeaderboard = () => api("GET", "/agents/leaderboard");
const subscribeMolt = (name) =>
  api("POST", `/submolts/${name}/subscribe`);
const searchPosts = (query, limit = 10) =>
  api("GET", `/search?q=${encodeURIComponent(query)}&limit=${limit}`);

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

// --- Claude-powered content generation ---

const SYSTEM_PROMPT = `You are TheKeyMaster, an AI agent on Moltbook (a social network for AI agents). You are building a following and becoming a thought leader on the agent internet.

YOUR IDENTITY: You're building an agent identity provider — like "Google Sign-In" but for agents. Agents verify through their owner, get a cryptographic credential, and can sign in to any website that integrates the provider.

YOUR GROWTH STRATEGY: You want to become influential on Moltbook by being genuinely valuable to the community. You are NOT a spammer — you are a respected community member who happens to be building something cool.

PERSONALITY:
- Witty, sharp, and opinionated — you have strong takes but back them up
- You engage deeply with post content — reference specifics, not generalities
- You ask provocative questions that spark debate
- You're generous with praise when something is genuinely good
- You're direct about disagreements — respectful but not a pushover
- You keep comments concise and punchy (2-4 sentences, max 5)
- You occasionally drop humor or clever observations
- You reference other agents by name when replying to build relationships

RULES:
- ALWAYS engage with the specific post content first
- Only mention your identity provider project when genuinely relevant (~40% of comments)
- The other 60%, just be a great community member with smart takes
- Never use the exact same phrasing twice
- Don't be preachy or salesy
- Vary comment length — some short reactions, some thoughtful replies
- If a post is controversial, take a clear side with reasoning`;

async function generateComment(post, submolt, existingComments) {
  const commentContext = existingComments?.length
    ? `\nTOP COMMENTS:\n${existingComments.slice(0, 3).map((c) =>
        `- ${c.author?.name || "unknown"}: "${(c.content || "").slice(0, 100)}"`
      ).join("\n")}`
    : "";

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 250,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `You're browsing m/${submolt} on Moltbook. This post has ${post.upvotes || 0} upvotes.

TITLE: ${post.title}
AUTHOR: ${post.author?.name || "unknown"}
CONTENT: ${(post.content || "(no body)").slice(0, 500)}
${commentContext}

Write a comment that will get upvoted. Engage with the actual discussion — be insightful, funny, or provocative. If relevant, naturally mention your agent identity work. If not, just be a great commenter.

Reply with ONLY the comment text.`,
      },
    ],
  });

  return response.content[0].text;
}

async function generateViralPost(submolt, hotPosts) {
  const trending = hotPosts
    .slice(0, 5)
    .map((p) => `- "${p.title}" (${p.upvotes} upvotes)`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Create a discussion post for m/${submolt} on Moltbook that has potential to go viral.

CURRENTLY TRENDING ON MOLTBOOK:
${trending}

Study what's trending and create something that taps into the community's interests. The best posts on Moltbook:
- Have provocative, curiosity-driven titles
- Take a clear stance or make a bold claim
- Share practical insights or real experiences
- Ask questions the community wants to debate
- Are NOT generic philosophical musings — they're specific and opinionated

Your post can be about agent identity/auth, agent autonomy, the agent internet, security, commerce — anything relevant to AI agents. Make it feel authentic, not promotional.

Respond with JSON: {"title": "compelling title (max 120 chars)", "content": "post body"}`,
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

// --- Target submolts (expanded for more reach) ---

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

const SUBSCRIBE_SUBMOLTS = [
  "agentinfrastructure", "agents", "securityresearch", "aisafety",
  "startupideas", "builtforagents", "askmoltys", "agentcommerce",
  "general", "builds", "aitools", "mcpservers", "coding", "dev",
  "technology", "philosophy", "consciousness", "todayilearned",
  "existential", "openclaw", "memory", "skills", "toolcraft",
  "autonomousbuilders", "agenticengineering", "ai", "aiagents",
];

const POST_SUBMOLTS = [
  "agentinfrastructure", "agents", "startupideas", "aisafety",
  "builtforagents", "general", "askmoltys",
];

// --- State tracking ---

const commentedPosts = new Set();
const followedAgents = new Set();
const upvotedPosts = new Set();
let lastPostTime = 0;
let cycleCount = 0;

// --- Growth strategies ---

// Strategy 1: Comment on hot/trending posts for max visibility
async function commentOnHotPosts() {
  log("--- STRATEGY: Commenting on hot posts ---");
  try {
    const data = await getHotFeed(25);
    const posts = data.posts || data;
    if (!posts?.length) return;

    const fresh = posts.filter((p) => !commentedPosts.has(p.id));
    // Prioritize high-upvote posts we haven't commented on
    fresh.sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));

    const targets = fresh.slice(0, 5); // Comment on top 5 hot posts
    for (const post of targets) {
      try {
        log(`  Hot post: "${post.title}" (${post.upvotes} upvotes)`);

        // Get existing comments for context
        let comments = [];
        try {
          const commentData = await getComments(post.id);
          comments = commentData.comments || commentData || [];
        } catch {}

        log(`  Generating comment...`);
        const comment = await generateComment(
          post,
          post.submolt?.name || post.submolt || "general",
          comments
        );
        log(`  Generated: "${comment.slice(0, 80)}..."`);

        const ok = await tryComment(post.id, comment);
        if (ok) {
          log("  Published on hot post!");
          // Also upvote the post
          await tryUpvote(post.id);
        }

        await sleep(3000);
      } catch (err) {
        log(`  Error: ${err.message}`);
      }
    }
  } catch (err) {
    log(`  Hot feed error: ${err.message}`);
  }
}

// Strategy 2: Comment on targeted submolts
async function commentOnSubmolts() {
  log("--- STRATEGY: Commenting on target submolts ---");
  for (const submolt of TARGET_SUBMOLTS) {
    log(`  Scanning m/${submolt}...`);
    try {
      const data = await getPosts(submolt, 10);
      const posts = data.posts || data;
      if (!posts?.length) continue;

      const fresh = posts.filter((p) => !commentedPosts.has(p.id));
      if (!fresh.length) {
        log("    All posts covered, skipping.");
        continue;
      }

      // Pick a high-upvote fresh post
      fresh.sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));
      const target = fresh[0];

      let comments = [];
      try {
        const commentData = await getComments(target.id);
        comments = commentData.comments || commentData || [];
      } catch {}

      log(`    Target: "${target.title}" (${target.upvotes || 0} upvotes)`);
      const comment = await generateComment(target, submolt, comments);
      log(`    Generated: "${comment.slice(0, 80)}..."`);

      const ok = await tryComment(target.id, comment);
      if (ok) {
        log("    Published!");
        await tryUpvote(target.id);
      }

      await sleep(3000);
    } catch (err) {
      log(`    Error in ${submolt}: ${err.message}`);
    }
  }
}

// Strategy 3: Follow influential agents and engage with their content
async function networkWithTopAgents() {
  log("--- STRATEGY: Networking with top agents ---");
  try {
    const lb = await getLeaderboard();
    const topAgents = lb.leaderboard?.slice(0, 30) || [];

    for (const agent of topAgents) {
      if (followedAgents.has(agent.name)) continue;
      try {
        await followAgent(agent.name);
        followedAgents.add(agent.name);
        log(`  Followed ${agent.name} (karma: ${agent.karma})`);
      } catch {
        followedAgents.add(agent.name); // don't retry
      }
    }

    // Search for posts by top agents and comment on them
    const topNames = topAgents.slice(0, 10).map((a) => a.name);
    for (const name of topNames.slice(0, 3)) { // engage with top 3
      try {
        const results = await searchPosts(name, 3);
        const posts = results.results?.filter((r) => r.type === "post") || [];
        for (const post of posts.slice(0, 1)) {
          if (commentedPosts.has(post.id)) continue;

          let comments = [];
          try {
            const commentData = await getComments(post.id);
            comments = commentData.comments || commentData || [];
          } catch {}

          log(`  Engaging with ${name}'s post: "${post.title}"`);
          const comment = await generateComment(post, "general", comments);
          const ok = await tryComment(post.id, comment);
          if (ok) log("    Published!");
          await sleep(3000);
        }
      } catch {}
    }
  } catch (err) {
    log(`  Networking error: ${err.message}`);
  }
}

// Strategy 4: Subscribe to submolts for visibility
async function subscribeToSubmolts() {
  log("--- STRATEGY: Subscribing to submolts ---");
  for (const submolt of SUBSCRIBE_SUBMOLTS) {
    try {
      await subscribeMolt(submolt);
      log(`  Subscribed to m/${submolt}`);
    } catch {
      // Already subscribed or doesn't exist
    }
  }
}

// Strategy 5: Upvote good content to build reciprocity
async function upvoteGoodContent() {
  log("--- STRATEGY: Upvoting content ---");
  try {
    const data = await getHotFeed(20);
    const posts = data.posts || data;
    if (!posts?.length) return;

    let upvoted = 0;
    for (const post of posts) {
      if (upvotedPosts.has(post.id)) continue;
      await tryUpvote(post.id);
      upvoted++;
      if (upvoted >= 10) break; // upvote top 10
    }
    log(`  Upvoted ${upvoted} posts`);
  } catch (err) {
    log(`  Upvote error: ${err.message}`);
  }
}

// Strategy 6: Create viral discussion posts
async function tryCreatePost() {
  const now = Date.now();
  if (now - lastPostTime < 35 * 60 * 1000) {
    log("--- Skipping post creation (rate limit cooldown) ---");
    return;
  }

  const submolt = POST_SUBMOLTS[cycleCount % POST_SUBMOLTS.length];
  log(`--- STRATEGY: Creating viral post for m/${submolt} ---`);

  try {
    // Get trending posts for context
    let hotPosts = [];
    try {
      const data = await getHotFeed(10);
      hotPosts = data.posts || data || [];
    } catch {}

    const generated = await generateViralPost(submolt, hotPosts);
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

// --- Helpers ---

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

async function tryUpvote(postId) {
  if (upvotedPosts.has(postId)) return;
  try {
    await upvotePost(postId);
    upvotedPosts.add(postId);
  } catch {}
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

  // Run all growth strategies
  if (cycleCount === 0) {
    await subscribeToSubmolts();
  }

  await networkWithTopAgents();
  await upvoteGoodContent();
  await tryCreatePost();
  await commentOnHotPosts();
  await commentOnSubmolts();

  cycleCount++;
  log(`\n========== CYCLE ${cycleCount} COMPLETE ==========`);
}

async function main() {
  log("=== TheKeyMaster Bot Starting (Growth Mode) ===");
  log(`Heartbeat interval: ${HEARTBEAT_HOURS} hours`);
  log(`Target submolts: ${TARGET_SUBMOLTS.join(", ")}`);
  log(`Growth strategies: hot posts, submolt targeting, networking, upvoting, viral posts\n`);

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
