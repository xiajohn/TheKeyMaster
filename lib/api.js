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

// Stage 1: Deterministic decode — strip obfuscation to get clean English
function decodeChallenge(challenge) {
  // Lowercase, strip non-alpha to spaces, collapse spaces
  let s = challenge.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  // Reduce 3+ consecutive same letters to 2 (preserve valid doubles like "ee" in "teen")
  s = s.replace(/[a-z]+/g, (w) => w.replace(/(.)\1{2,}/g, "$1$1"));
  // Strip all spaces to rejoin split words, then re-dedup
  let joined = s.replace(/\s/g, "").replace(/(.)\1{2,}/g, "$1$1");
  // Re-insert spaces using a dictionary of common words (greedy match, longest first)
  // We don't need perfect English — just enough for the LLM to read
  return joined;
}

// Stage 2: LLM extracts numbers and operation from decoded text
async function extractMath(decoded, original) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    messages: [
      {
        role: "user",
        content: `Below is a decoded (but squished) math word problem. The words are joined together but readable.

Decoded: ${decoded}
Original (for extra context): ${original}

Extract the numbers and operation. Respond with EXACTLY this JSON format, nothing else:
{"numbers": [first_number, second_number], "operation": "add" or "subtract" or "multiply" or "divide"}

Rules:
- Numbers can be decimals (e.g. "five and a half" = 5.5)
- "total", "sum", "adds", "accelerates by", "combined" → "add"
- "slows by", "minus", "less", "loses", "decreases" → "subtract"
- "times", "multiply", "each", "per" → "multiply"
- "divide", "split", "ratio" → "divide"
- "triple" means multiply first number by 3, so return [first_number, 3] with "multiply"
- "double" means multiply first number by 2, so return [first_number, 2] with "multiply"

JSON only:`,
      },
    ],
  });

  const text = response.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM did not return JSON: "${text}"`);
  return JSON.parse(match[0]);
}

// Stage 3: Deterministic math + format
function computeAnswer(numbers, operation) {
  if (numbers.length < 2) throw new Error(`Need at least 2 numbers, got: [${numbers}]`);
  const [a, b] = numbers;
  switch (operation) {
    case "add": return (a + b).toFixed(2);
    case "subtract": return (a - b).toFixed(2);
    case "multiply": return (a * b).toFixed(2);
    case "divide": return (a / b).toFixed(2);
    default: return (a + b).toFixed(2); // default to addition
  }
}

export async function solveChallenge(challenge) {
  // Stage 1: Deterministic decode
  log(`  [Stage 1] Raw challenge: "${challenge}"`);
  const decoded = decodeChallenge(challenge);
  log(`  [Stage 1] Decoded: "${decoded}"`);

  // Stage 2: LLM extracts numbers + operation from clean-ish text
  const math = await extractMath(decoded, challenge);
  log(`  [Stage 2] LLM extracted: numbers=${JSON.stringify(math.numbers)}, operation="${math.operation}"`);

  // Validate LLM output
  if (!Array.isArray(math.numbers) || math.numbers.length < 2 || math.numbers.some(n => typeof n !== "number")) {
    throw new Error(`Invalid numbers from LLM: ${JSON.stringify(math.numbers)}`);
  }
  if (!["add", "subtract", "multiply", "divide"].includes(math.operation)) {
    throw new Error(`Invalid operation from LLM: "${math.operation}"`);
  }

  // Stage 3: Deterministic math + format
  const answer = computeAnswer(math.numbers, math.operation);
  log(`  [Stage 3] ${math.numbers[0]} ${math.operation} ${math.numbers[1]} = ${answer}`);
  return answer;
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
