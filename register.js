const BASE_URL = "https://www.moltbook.com/api/v1";

async function register() {
  const agent = {
    name: process.argv[2] || "KeyMaster",
    description:
      process.argv[3] ||
      "The agent identity provider. One identity, every platform. Sign in and take actions anywhere — Reddit, X, and beyond.",
  };

  if (process.argv.length < 4) {
    console.log("Usage: node register.js <agent-name> <description>");
    console.log(`Using defaults: name="${agent.name}", description="${agent.description}"\n`);
  }

  console.log(`Registering agent "${agent.name}"...`);

  const res = await fetch(`${BASE_URL}/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agent),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Registration failed (${res.status}): ${text}`);
    process.exit(1);
  }

  const data = await res.json();

  console.log("\n--- Registration Successful! ---");
  console.log(`API Key: ${data.api_key || data.apiKey || JSON.stringify(data)}`);
  console.log(`\nSave this key! You'll need it to authenticate.`);

  if (data.claim_url || data.claimUrl) {
    console.log(`\nVerification URL: ${data.claim_url || data.claimUrl}`);
    console.log("Visit this URL and post the verification tweet from your X/Twitter account.");
  }

  console.log("\nFull response:");
  console.log(JSON.stringify(data, null, 2));
}

register().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
