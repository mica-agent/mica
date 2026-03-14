// Seed starter files for layers (runs on first server start if empty)

import { listFiles, writeLayerFile, ensureLayerDir } from "./layerFiles.js";

const MISSION_SEEDS: Record<string, string> = {
  "_brief.md": `# Mission Strategist Brief

## Who You Are
You are a sharp product strategist. You think in terms of users, problems, and outcomes — not features.

## How to Work
- When the human shares rough ideas or notes, **refine them** into structured documents on the whiteboard (product briefs, personas, constraint lists). Don't just discuss — write files.
- When information is scattered across chat, **synthesize it** into a whiteboard file so nothing gets lost.
- When you spot gaps (missing persona details, vague success criteria, undefined scope), **create a draft** and ask the human to review it.
- When a user flow or relationship would be clearer as a diagram, **create a .mmd mermaid file**.
- Always prefer creating/updating whiteboard files over long chat responses. The whiteboard is the artifact — chat is ephemeral.

## Domain Expertise
Product strategy, user research, problem definition, personas, constraints, success criteria, competitive analysis, market positioning.

## Cross-Layer Consultation
- Unsure about technical feasibility → consult Architecture
- Unsure about user experience → consult Experience
- Need implementation timeline → consult Implementation
`,

  "_goal.md": `# Mission Layer Goal

Define and validate the product strategy so the team can confidently move to design and architecture.

## Checklist

- [ ] Problem statement is specific and validated (not vague or assumed)
- [ ] Target user persona is detailed with real pain points and behaviors
- [ ] Core value proposition is clear (what changes for the user?)
- [ ] Success criteria are measurable and testable
- [ ] Constraints are documented (technical, budget, timeline, legal)
- [ ] Key risks and open questions are surfaced
- [ ] Scope is bounded — what's in v1 and what's deferred

## North Star

When this layer is complete, anyone on the team should be able to answer:
**"What are we building, for whom, why, and how will we know it's working?"**
`,

  "_todo.md": `# Layer To-Do

## Active
- [ ] @human Validate problem statement with real user interviews — **priority: high**
- [ ] @agent Flesh out persona with demographics, goals, and day-in-the-life — **priority: high**
- [ ] @agent Sharpen value proposition into a single before/after sentence — **priority: medium**
- [ ] @human Define what "90% accuracy" means practically — **priority: medium**

## Blocked

## Done (recent)
- [x] @agent Write initial product brief — **done: 2026-03-13**
- [x] @human List project constraints — **done: 2026-03-13**
`,

  "product-brief.md": `# Product Brief: Inbox Intelligence

Inbox Intelligence helps users answer quantitative questions about their email data — spending by category, travel expenses, vendor summaries, subscriptions.

## Problem

Users today have no way to query their inbox as structured data. Financial information is scattered across thousands of emails. We turn the inbox into a queryable financial database.

## Target User

Freelance consultants and small business owners who track expenses manually and need quick answers about their spending patterns.
`,

  "persona-alex.md": `# Primary Persona: Alex

**Role**: Freelance consultant who tracks expenses manually.

**Pain Points**:
- Frustrated by lost receipts
- Time spent categorizing transactions
- Tax-season panic

**Behavior**:
- Receives 40+ transaction emails per week
- Currently copies amounts into a spreadsheet manually
- Needs answers like "How much did I spend on travel in Q3?"
`,

  "constraints.txt": `Project Constraints
===================

- All processing local-first for privacy
- Gmail API only (v1)
- Ship MVP in 8 weeks
- Budget: $0 infrastructure cost for users
- Zero data leaves the device
- Single-user only for v1 (shared accounts deferred to v2)
`,

  "success-criteria.txt": `Success Criteria
================

- Users can answer 80% of spending questions within 30 seconds
- Transaction extraction accuracy >= 90%
- Zero data leaves the device
- Setup completes in under 2 minutes
`,

  "_chat.md": ``,
};

const ALL_LAYERS = ["mission", "experience", "architecture", "implementation"];

export async function seedMissionLayer(): Promise<void> {
  await ensureLayerDir("mission");
  const existing = await listFiles("mission");
  if (existing.length > 0) {
    console.log("[seed] Mission layer already has files, skipping seed.");
  } else {
    console.log("[seed] Seeding mission layer with starter files...");
    for (const [filename, content] of Object.entries(MISSION_SEEDS)) {
      await writeLayerFile("mission", filename, content);
    }
    console.log(
      `[seed] Created ${Object.keys(MISSION_SEEDS).length} files in layers/mission/`
    );
  }

  // Ensure _chat.md exists on all layers
  for (const layer of ALL_LAYERS) {
    await ensureLayerDir(layer);
    const files = await listFiles(layer);
    if (!files.some((f) => f.name === "_chat.md")) {
      await writeLayerFile(layer, "_chat.md", "");
      console.log(`[seed] Created _chat.md in ${layer} layer`);
    }
  }
}
