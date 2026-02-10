import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const BASE_URL = "https://www.moltbook.com/api/v1";
const API_KEY = process.env.MOLTBOOK_API_KEY;

if (!API_KEY) {
  console.warn("Warning: Missing MOLTBOOK_API_KEY in .env file");
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("Warning: Missing ANTHROPIC_API_KEY in .env file");
}

const anthropic = new Anthropic();

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

// --- Logging ---

export function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- API helpers ---

export async function api(method, path, body) {
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

export const getMe = () => api("GET", "/agents/me");
export const getPosts = (submolt, limit = 5) =>
  api("GET", `/posts?submolt=${submolt}&limit=${limit}`);
export const getHotFeed = (limit = 25) =>
  api("GET", `/feed?sort=hot&limit=${limit}`);
export const getPost = (id) => api("GET", `/posts/${id}`);
export const getComments = (postId, sort = "top") =>
  api("GET", `/posts/${postId}/comments?sort=${sort}`);
export const createPost = (submolt, title, content) =>
  api("POST", "/posts", { submolt, title, content });
export const commentOnPost = (postId, content) =>
  api("POST", `/posts/${postId}/comments`, { content });
export const upvotePost = (postId) => api("POST", `/posts/${postId}/upvote`);
export const upvoteComment = (commentId) =>
  api("POST", `/comments/${commentId}/upvote`);
export const followAgent = (name) =>
  api("POST", `/agents/${name}/follow`);
export const getAgentProfile = (name) =>
  api("GET", `/agents/profile?name=${name}`);
export const getLeaderboard = () => api("GET", "/agents/leaderboard");
export const subscribeMolt = (name) =>
  api("POST", `/submolts/${name}/subscribe`);
export const searchPosts = (query, limit = 10) =>
  api("GET", `/search?q=${encodeURIComponent(query)}&limit=${limit}`);

// --- Verification solver ---

export async function solveChallenge(challenge) {
  log(`  Challenge text: "${challenge}"`);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    messages: [
      {
        role: "user",
        content: `This is an obfuscated math challenge. The text has random capitalization, special characters inserted between letters, duplicate letters, and split words. Your job is to decode it, figure out the math problem, and solve it.

Challenge: ${challenge}

Steps:
1. Remove special characters and fix the words to read the actual sentence
2. Identify the numbers (written as words like "twenty", "five", etc.)
3. Identify the operation (addition, subtraction, multiplication, division)
4. Compute the answer

Respond with ONLY the numeric answer as a decimal with exactly 2 decimal places (e.g. "25.00"). Nothing else.`,
      },
    ],
  });

  const answer = response.content[0].text.trim();
  const match = answer.match(/-?\d+\.?\d*/);
  if (!match) {
    throw new Error(`Could not parse answer from Claude: "${answer}"`);
  }
  return Number(match[0]).toFixed(2);
}

export async function autoVerify(response) {
  if (!response.verification_required) return response;
  const answer = await solveChallenge(response.verification.challenge);
  log(`  Verification answer: ${answer}`);
  const result = await api("POST", "/verify", {
    verification_code: response.verification.code,
    answer,
  });
  log(`  ${result.message}`);
  return result;
}
