import http from "http";

const XEV_URL = process.env.XEV_URL || "http://localhost:3000/v1/systemone";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "http://127.0.0.1:1234/v1";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "qwen/qwen3.5-9b";

// ── Random States ──────────────────────────────────────────────────────────
const STATES = [
  "I've been waiting 3 weeks for my refund. This is unacceptable!",
  "Your API docs are unclear, can someone help me understand the auth flow?",
  "The dashboard is loading super slowly today, taking 30+ seconds.",
  "I'd like to upgrade my plan to the enterprise tier.",
  "We discovered a critical security vulnerability in your webhook handler.",
  "My team can't export reports to PDF since the last update.",
  "Just wanted to say your product is amazing, keep up the great work!",
  "I was charged twice for my subscription this month.",
  "Is there a way to integrate your platform with Slack?",
  "The mobile app crashes every time I try to upload a file over 10MB.",
  "We need to cancel our account immediately due to GDPR compliance issues.",
  "How do I add more team members to my workspace?",
  "Your service has been down for 2 hours. Our production is affected.",
  "I'd like to schedule a demo for our 50-person engineering team.",
  "The billing page shows wrong currency, I see USD but I'm in Europe.",
];

// ── Questions ──────────────────────────────────────────────────────────────
const QUESTIONS = {
  department: {
    type: "choice",
    instructions: "Which team should handle this request?",
    criteria: {
      support: "General help, how-to questions, account issues",
      engineering: "Bugs, outages, technical problems, API issues",
      billing: "Charges, invoices, refunds, subscriptions",
      sales: "Upgrades, demos, new accounts, pricing",
      security: "Vulnerabilities, compliance, data protection",
    },
  },
  urgency: {
    type: "score",
    instructions: "How urgent is this request?",
    criteria: [
      "Low - informational, no action needed soon",
      "Medium - should be handled within 24 hours",
      "High - needs attention today",
      "Critical - immediate action required",
    ],
  },
  is_complaint: {
    type: "noul",
    instructions: "Is the customer expressing dissatisfaction or filing a complaint?",
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        "x-llm-base-url": LLM_BASE_URL,
        "x-llm-api-key": LLM_API_KEY,
        "x-llm-model": LLM_MODEL,
      },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Failed to parse response: ${body.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function printAnswer(id, answer) {
  if (answer.type === "choice") {
    const top = Object.entries(answer.probabilities)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${(v * 100).toFixed(0)}%`)
      .join(", ");
    console.log(`  [choice]  ${id} => "${answer.choice}" (confidence: ${answer.confidence.toFixed(2)})`);
    console.log(`            probabilities: ${top}`);
  } else if (answer.type === "score") {
    const top = Object.entries(answer.probabilities)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${answer.legend[k]}: ${(v * 100).toFixed(0)}%`)
      .join(", ");
    console.log(`  [score]   ${id} => ${answer.score.toFixed(2)} (confidence: ${answer.confidence.toFixed(2)})`);
    console.log(`            top: ${top}`);
  } else if (answer.type === "noul") {
    const label = answer.noul > 0.7 ? "YES" : answer.noul < 0.3 ? "NO" : "MAYBE";
    console.log(`  [noul]    ${id} => ${answer.noul.toFixed(2)} (${label})`);
  }
}

function makeDecision(answers) {
  const dept = answers.department?.choice;
  const urgency = answers.urgency?.score ?? 0;
  const complaint = answers.is_complaint?.noul ?? 0;

  const actions = [];

  // Route to team
  actions.push(`Route to: ${dept}`);

  // Priority
  if (urgency >= 3) actions.push("Priority: CRITICAL - escalate immediately");
  else if (urgency >= 2) actions.push("Priority: HIGH - handle today");
  else if (urgency >= 1) actions.push("Priority: MEDIUM - handle within 24h");
  else actions.push("Priority: LOW - handle when available");

  // Complaint handling
  if (complaint > 0.7) actions.push("Action: Flag for customer success follow-up");
  if (complaint > 0.5 && urgency >= 2) actions.push("Action: Offer compensation / discount");

  // Security escalation
  if (dept === "security") actions.push("Action: Notify CISO team immediately");

  return actions;
}

// ── Main Loop ──────────────────────────────────────────────────────────────
async function main() {
  const count = parseInt(process.argv[2] || "5", 10);
  console.log(`\nXev Decision Demo - evaluating ${count} random states\n${"=".repeat(50)}\n`);

  for (let i = 0; i < count; i++) {
    const state = pickRandom(STATES);
    console.log(`--- Request ${i + 1} ---`);
    console.log(`State: "${state}"\n`);

    try {
      const response = await postJson(XEV_URL, {
        state,
        model: "demo",
        questions: QUESTIONS,
      });

      if (response.error) {
        console.error(`API Error: ${response.error}`);
        console.log("");
        continue;
      }

      for (const [id, answer] of Object.entries(response.answers)) {
        printAnswer(id, answer);
      }

      console.log("\nDecision:");
      const actions = makeDecision(response.answers);
      actions.forEach((a) => console.log(`  -> ${a}`));

      console.log(`\nTokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }

    console.log("");
  }
}

main();
