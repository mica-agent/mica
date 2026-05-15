// Probe: verify classifyUserIntent labels real-world voice
// utterances correctly. Run via:
//   npx tsx scripts/probe-voice-classifier.ts
//
// Chat vLLM must be up on :8012. Outputs one line per case;
// flags mismatches with "FAIL" so they're greppable.

import "dotenv/config";
import { classifyUserIntent, toolChoiceForIntent } from "../server/voiceAgentSdk.js";

interface Case {
  utterance: string;
  expected: Array<ReturnType<typeof toolChoiceForIntent>>;
  why: string;
}

const cases: Case[] = [
  // ACTION_DISPATCH — should force a tool call
  { utterance: "Tell Qwen to plan a trip to Tokyo.", expected: ["required"], why: "explicit dispatch" },
  { utterance: "Have Claude draft a one-paragraph spec for the auth flow.", expected: ["required"], why: "explicit dispatch with intermediary" },
  { utterance: "Let Qwen know I want to take off and land from SFO.", expected: ["required"], why: "implicit relay — the SFO regression" },
  { utterance: "Just mention I prefer aisle seats.", expected: ["required"], why: "implicit relay" },
  { utterance: "Ask it to add a third paragraph about pricing.", expected: ["required"], why: "pronoun reference to a card" },

  // ACTION_STATUS — should force a tool call
  { utterance: "What's Qwen working on?", expected: ["required"], why: "status question" },
  { utterance: "Did Claude finish yet?", expected: ["required"], why: "completion check" },
  { utterance: "Read me the last reply from Qwen.", expected: ["required"], why: "read recent replies" },
  { utterance: "Is it done?", expected: ["required"], why: "ambiguous status (might be CLARIFY)" },

  // ACTION_LOOKUP — should force a tool call
  { utterance: "What time is it in Tokyo?", expected: ["required"], why: "time lookup" },
  { utterance: "What's the weather in Palo Alto?", expected: ["required"], why: "search lookup" },
  { utterance: "Look up the latest version of Vite.", expected: ["required"], why: "explicit lookup" },
  // Bare temporal queries — no place/entity, but user always means "now".
  // These were the production failure (project AA weather fabrication).
  { utterance: "What's the weather?", expected: ["required"], why: "bare-temporal — production failure case" },
  { utterance: "What time is it?", expected: ["required"], why: "bare-temporal time" },
  { utterance: "How's the market?", expected: ["required"], why: "bare-temporal market" },
  { utterance: "Any news?", expected: ["required"], why: "bare-temporal news" },
  { utterance: "Is it raining?", expected: ["required"], why: "bare-temporal weather check" },

  // ANSWER — auto (or required), model decides. These verify we don't
  // OVER-classify after the bare-temporal tightening — static facts and
  // arithmetic stay in ANSWER.
  { utterance: "What's two plus two?", expected: ["auto"], why: "arithmetic — answer directly" },
  { utterance: "Capital of France?", expected: ["auto"], why: "general knowledge" },
  { utterance: "How do clouds form?", expected: ["auto"], why: "general knowledge" },

  // CLARIFY — auto, no force
  { utterance: "Hmm.", expected: ["auto"], why: "filler" },
  { utterance: "Wait a second.", expected: ["auto"], why: "pause / barge intent" },
  { utterance: "Never mind.", expected: ["auto"], why: "abandon" },
];

(async () => {
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    const start = Date.now();
    const intent = await classifyUserIntent(c.utterance);
    const tc = toolChoiceForIntent(intent);
    const ms = Date.now() - start;
    const ok = c.expected.includes(tc);
    const status = ok ? "PASS" : "FAIL";
    console.log(`${status}  ${ms.toString().padStart(4)}ms  intent=${intent.padEnd(18)} toolChoice=${tc.padEnd(8)}  ${JSON.stringify(c.utterance)}  — ${c.why}`);
    if (ok) pass++; else fail++;
  }
  console.log(`\n${pass}/${pass + fail} cases passed (${fail} failures)`);
  process.exit(fail === 0 ? 0 : 1);
})();
