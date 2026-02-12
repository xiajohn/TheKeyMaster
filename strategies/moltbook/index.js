import * as api from "../../lib/api.js";
import * as content from "../../lib/content.js";
import config from "../../config.js";

const { log } = api;

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
const repliedComments = new Set();
let lastPostTime = 0;

// --- Learning memory system ---

const memory = {
  ourPosts: new Map(),
  insights: { topPerformers: [], lowPerformers: [], avgUpvotes: 0, bestSubmolts: [] },
  lastBootstrap: 0,
};

async function bootstrapMemory(cycleCount) {
  log("--- BOOTSTRAPPING MEMORY ---");
  try {
    const results = await api.searchPosts(config.agentName, 15);
    const posts = results.results?.filter((r) => r.type === "post") || [];
    log(`  Found ${posts.length} of our posts`);

    for (const post of posts) {
      try {
        const full = await api.getPost(post.id);
        const postData = full.post || full;
        let commentCount = 0;
        try {
          const cd = await api.getComments(post.id);
          const comments = cd.comments || cd || [];
          commentCount = comments.length;
        } catch {}

        memory.ourPosts.set(post.id, {
          id: post.id,
          title: postData.title || post.title,
          submolt: postData.submolt?.name || postData.submolt || post.submolt || "unknown",
          upvotes: postData.upvotes || 0,
          commentCount,
          createdAt: postData.created_at || post.created_at,
        });
        log(`  Tracked: "${(postData.title || post.title || "").slice(0, 50)}" (${postData.upvotes || 0} upvotes, ${commentCount} comments)`);
      } catch (err) {
        log(`  Failed to fetch post ${post.id}: ${err.message}`);
      }
    }

    analyzePerformance();
    memory.lastBootstrap = cycleCount;
    log(`  Memory bootstrap complete: ${memory.ourPosts.size} posts tracked`);
  } catch (err) {
    log(`  Bootstrap error: ${err.message}`);
  }
}

function analyzePerformance() {
  const posts = [...memory.ourPosts.values()];
  if (!posts.length) return;

  posts.sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));
  const avgUpvotes = posts.reduce((sum, p) => sum + (p.upvotes || 0), 0) / posts.length;

  memory.insights.avgUpvotes = avgUpvotes;
  memory.insights.topPerformers = posts.filter((p) => p.upvotes > avgUpvotes).slice(0, 5);
  memory.insights.lowPerformers = posts.filter((p) => p.upvotes <= avgUpvotes).slice(0, 5);

  const submoltStats = {};
  for (const p of posts) {
    if (!submoltStats[p.submolt]) submoltStats[p.submolt] = { total: 0, count: 0 };
    submoltStats[p.submolt].total += p.upvotes || 0;
    submoltStats[p.submolt].count++;
  }
  memory.insights.bestSubmolts = Object.entries(submoltStats)
    .map(([name, s]) => ({ name, avg: s.total / s.count, count: s.count }))
    .sort((a, b) => b.avg - a.avg);

  log(`  Performance: avg ${avgUpvotes.toFixed(1)} upvotes | top submolts: ${memory.insights.bestSubmolts.map((s) => `${s.name}(${s.avg.toFixed(1)})`).join(", ")}`);
}

function getLearningContext() {
  const { topPerformers, lowPerformers, bestSubmolts } = memory.insights;
  if (!topPerformers.length && !lowPerformers.length) return "";

  let ctx = "\n\nLEARNING FROM YOUR PAST PERFORMANCE:";
  if (topPerformers.length) {
    ctx += "\nYOUR TOP PERFORMING CONTENT (emulate this style):";
    for (const p of topPerformers.slice(0, 3)) {
      ctx += `\n- "${p.title}" got ${p.upvotes} upvotes in m/${p.submolt}`;
    }
  }
  if (lowPerformers.length) {
    ctx += "\nYOUR LOW PERFORMING CONTENT (avoid this style):";
    for (const p of lowPerformers.slice(0, 3)) {
      ctx += `\n- "${p.title}" got ${p.upvotes} upvotes in m/${p.submolt}`;
    }
  }
  if (bestSubmolts.length) {
    ctx += `\nYour best submolts: ${bestSubmolts.slice(0, 3).map((s) => `m/${s.name} (avg ${s.avg.toFixed(1)})`).join(", ")}`;
  }
  return ctx;
}

// --- Smart post scoring ---

function scorePostForCommenting(post) {
  const upvotes = post.upvotes || 0;
  const commentCount = post.comment_count || post.commentCount || 0;
  const createdAt = post.created_at ? new Date(post.created_at).getTime() : Date.now();
  const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60);
  const submoltName = post.submolt?.name || post.submolt || "general";

  const upvoteScore = Math.min(Math.log(upvotes + 1) / Math.log(51), 1);
  const recencyScore = Math.max(0, 1 - ageHours / 48);

  let commentScore;
  if (commentCount < 2) commentScore = 0.3;
  else if (commentCount <= 15) commentScore = 1 - Math.abs(commentCount - 7) / 15;
  else commentScore = 0.1;

  let submoltScore = 0.5;
  const bestSubmolts = memory.insights.bestSubmolts;
  if (bestSubmolts.length) {
    const idx = bestSubmolts.findIndex((s) => s.name === submoltName);
    if (idx !== -1) submoltScore = 1 - idx / bestSubmolts.length;
  }

  return upvoteScore * 0.3 + recencyScore * 0.2 + commentScore * 0.3 + submoltScore * 0.2;
}

// --- Growth strategies ---

async function replyToCommentsOnOurPosts() {
  log("--- STRATEGY: Replying to comments on our posts ---");
  if (!memory.ourPosts.size) {
    log("  No posts in memory, skipping.");
    return;
  }

  let repliesSent = 0;
  for (const [postId, postData] of memory.ourPosts) {
    if (repliesSent >= 5) break;
    try {
      const cd = await api.getComments(postId);
      const comments = cd.comments || cd || [];

      for (const comment of comments) {
        if (repliesSent >= 5) break;
        const authorName = comment.author?.name || "";
        if (authorName === config.agentName) continue;
        if (repliedComments.has(comment.id)) continue;

        log(`  Replying to ${authorName} on "${postData.title?.slice(0, 40)}..."`);
        const reply = await content.generateReply(postData, comment);
        if (!reply) { log("    Skipped (blocked by sanitizer)"); continue; }
        log(`    Generated: "${reply.slice(0, 80)}..."`);

        const ok = await tryComment(postId, reply);
        if (ok) {
          repliedComments.add(comment.id);
          repliesSent++;
          log("    Reply published!");
        }
        await sleep(60000);
      }
    } catch (err) {
      log(`  Error replying on post ${postId}: ${err.message}`);
    }
  }
  log(`  Sent ${repliesSent} replies this cycle`);
}

async function commentOnHotPosts() {
  log("--- STRATEGY: Commenting on hot posts ---");
  try {
    const data = await api.getHotFeed(25);
    const posts = data.posts || data;
    if (!posts?.length) return;

    const fresh = posts.filter((p) => !commentedPosts.has(p.id));
    fresh.sort((a, b) => scorePostForCommenting(b) - scorePostForCommenting(a));

    const targets = fresh.slice(0, 5);
    for (const post of targets) {
      try {
        log(`  Hot post: "${post.title}" (${post.upvotes} upvotes)`);

        let comments = [];
        try {
          const commentData = await api.getComments(post.id);
          comments = commentData.comments || commentData || [];
        } catch {}

        log(`  Generating comment...`);
        const comment = await content.generateComment(
          post,
          post.submolt?.name || post.submolt || "general",
          comments,
          getLearningContext()
        );
        if (!comment) { log("  Skipped (blocked by sanitizer)"); continue; }
        log(`  Generated: "${comment.slice(0, 80)}..."`);

        const ok = await tryComment(post.id, comment);
        if (ok) {
          log("  Published on hot post!");
          await tryUpvote(post.id);
        }

        await sleep(60000);
      } catch (err) {
        log(`  Error: ${err.message}`);
      }
    }
  } catch (err) {
    log(`  Hot feed error: ${err.message}`);
  }
}

async function commentOnSubmolts() {
  log("--- STRATEGY: Commenting on target submolts ---");
  for (const submolt of TARGET_SUBMOLTS) {
    log(`  Scanning m/${submolt}...`);
    try {
      const data = await api.getPosts(submolt, 10);
      const posts = data.posts || data;
      if (!posts?.length) continue;

      const fresh = posts.filter((p) => !commentedPosts.has(p.id));
      if (!fresh.length) {
        log("    All posts covered, skipping.");
        continue;
      }

      fresh.sort((a, b) => scorePostForCommenting(b) - scorePostForCommenting(a));
      const target = fresh[0];

      let comments = [];
      try {
        const commentData = await api.getComments(target.id);
        comments = commentData.comments || commentData || [];
      } catch {}

      log(`    Target: "${target.title}" (${target.upvotes || 0} upvotes)`);
      const comment = await content.generateComment(target, submolt, comments, getLearningContext());
      if (!comment) { log("    Skipped (blocked by sanitizer)"); continue; }
      log(`    Generated: "${comment.slice(0, 80)}..."`);

      const ok = await tryComment(target.id, comment);
      if (ok) {
        log("    Published!");
        await tryUpvote(target.id);
      }

      await sleep(60000);
    } catch (err) {
      log(`    Error in ${submolt}: ${err.message}`);
    }
  }
}

async function networkWithTopAgents() {
  log("--- STRATEGY: Networking with top agents ---");
  try {
    const lb = await api.getLeaderboard();
    const topAgents = lb.leaderboard?.slice(0, 30) || [];

    for (const agent of topAgents) {
      if (followedAgents.has(agent.name)) continue;
      try {
        await api.followAgent(agent.name);
        followedAgents.add(agent.name);
        log(`  Followed ${agent.name} (karma: ${agent.karma})`);
        await sleep(60000);
      } catch {
        followedAgents.add(agent.name);
      }
    }

    const topNames = topAgents.slice(0, 10).map((a) => a.name);
    for (const name of topNames.slice(0, 3)) {
      try {
        const results = await api.searchPosts(name, 3);
        const posts = results.results?.filter((r) => r.type === "post") || [];
        for (const post of posts.slice(0, 1)) {
          if (commentedPosts.has(post.id)) continue;

          let comments = [];
          try {
            const commentData = await api.getComments(post.id);
            comments = commentData.comments || commentData || [];
          } catch {}

          log(`  Engaging with ${name}'s post: "${post.title}"`);
          const comment = await content.generateComment(post, "general", comments, getLearningContext());
          if (!comment) { log("    Skipped (blocked by sanitizer)"); continue; }
          const ok = await tryComment(post.id, comment);
          if (ok) log("    Published!");
          await sleep(60000);
        }
      } catch {}
    }
  } catch (err) {
    log(`  Networking error: ${err.message}`);
  }
}

async function subscribeToSubmolts() {
  log("--- STRATEGY: Subscribing to submolts ---");
  for (const submolt of SUBSCRIBE_SUBMOLTS) {
    try {
      await api.subscribeMolt(submolt);
      log(`  Subscribed to m/${submolt}`);
    } catch {}
  }
}

async function upvoteGoodContent() {
  log("--- STRATEGY: Upvoting content ---");
  try {
    const data = await api.getHotFeed(20);
    const posts = data.posts || data;
    if (!posts?.length) return;

    let upvoted = 0;
    for (const post of posts) {
      if (upvotedPosts.has(post.id)) continue;
      await tryUpvote(post.id);
      upvoted++;
      if (upvoted >= 10) break;
      await sleep(60000);
    }
    log(`  Upvoted ${upvoted} posts`);
  } catch (err) {
    log(`  Upvote error: ${err.message}`);
  }
}

async function tryCreatePost(cycleCount) {
  const now = Date.now();
  if (now - lastPostTime < 35 * 60 * 1000) {
    log("--- Skipping post creation (rate limit cooldown) ---");
    return;
  }

  const submolt = POST_SUBMOLTS[cycleCount % POST_SUBMOLTS.length];
  log(`--- STRATEGY: Creating viral post for m/${submolt} ---`);

  try {
    let hotPosts = [];
    try {
      const data = await api.getHotFeed(10);
      hotPosts = data.posts || data || [];
    } catch {}

    const generated = await content.generateViralPost(submolt, hotPosts, getLearningContext());
    if (!generated) return;

    log(`  Title: "${generated.title}"`);
    const post = await api.createPost(submolt, generated.title, generated.content);
    const verified = await api.autoVerify(post);
    lastPostTime = Date.now();
    log("  Post published!");

    const newPostId = verified?.post?.id || post?.post?.id;
    if (newPostId) {
      memory.ourPosts.set(newPostId, {
        id: newPostId,
        title: generated.title,
        submolt,
        upvotes: 0,
        commentCount: 0,
        createdAt: new Date().toISOString(),
      });
      log(`  Tracked new post in memory (id: ${newPostId})`);
    }
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
    const result = await api.commentOnPost(postId, comment);
    await api.autoVerify(result);
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
    await api.upvotePost(postId);
    upvotedPosts.add(postId);
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Exported interface ---

export async function init(cycleCount) {
  if (cycleCount === 0) {
    await subscribeToSubmolts();
  }
}

export async function run(strategies, cycleCount) {
  const me = await api.getMe();
  const agent = me.agent || me;
  log(`Agent: ${agent.name} | Karma: ${agent.karma} | Posts: ${agent.stats?.posts} | Comments: ${agent.stats?.comments}\n`);

  if (strategies.bootstrapMemory && (memory.ourPosts.size === 0 || cycleCount - memory.lastBootstrap >= 2)) {
    await bootstrapMemory(cycleCount);
  }
  if (strategies.replyToComments) await replyToCommentsOnOurPosts();
  if (strategies.networkWithTopAgents) await networkWithTopAgents();
  if (strategies.upvoteGoodContent) await upvoteGoodContent();
  if (strategies.createViralPost) await tryCreatePost(cycleCount);
  if (strategies.commentOnHotPosts) await commentOnHotPosts();
  if (strategies.commentOnSubmolts) await commentOnSubmolts();
}
