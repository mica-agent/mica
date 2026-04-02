# Mica — Positioning & Messaging

---

## Where we are now

### What we've ruled out
- **"Every session starts from zero"** — Too hyperbolic. Skilled users have workarounds. And it's selling a problem most people don't feel acutely.
- **"Persistent context" / "context for the team"** — Jargon. Regular people don't think in terms of "context."
- **"A workspace for you and your AI"** — Too vague. "Ok, so... what do I do with it?"
- **"Get things done together"** — Weak. Generic.
- **"Give your project an AI team"** — "Team" sounds like org charts and layoffs. Wrong associations.
- **"Builder" as the lead audience frame** — Too narrow.
- **"Canvas" as the hero** — Important mechanism, not the main promise.
- **"Force multiplier"** — Directionally right, too abstract alone.
- **"Surface"** — Technobabble. Nobody outside AI circles talks about "surfaces."

### Where we've landed
**"AI helps in the moment. Mica keeps the whole effort moving."**

The internal frame: **Mica is the OS for layered work.** A place where you and your agents can work across time, across concerns, and across levels — from "what am I trying to do" down to "here's the code" — without everything collapsing back into disconnected chats and docs.

Real work happens in layers: intent → strategy → plan → structure → task → implementation → monitoring → revision. Most AI tools flatten all of that into a single thread. Mica gives it somewhere to live.

The name carries this: mica is a layered mineral. Layers that accumulate.

### What's still open
The one-line pitch that makes a non-engineer immediately see the value — not by selling a problem, but by showing something they didn't know they wanted. We're close but not crisp yet.

---

## Positioning

### Core frame
AI is getting good at helping in the moment. The unmet need is not more action — it's a place where those actions, decisions, and results stay organized, connected, and alive over time.

Mica gives you a place where agents create useful, living things — cards — that hold the work as it evolves. Plans. Trackers. Research. Dashboards. Decisions. Diagrams. Workflows. Monitors. Prototypes. These aren't just outputs you download. They're the ongoing body of work, right there in front of you.

You don't need to start in the details. Work usually starts higher:
- what am I trying to do?
- what matters?
- what are the constraints?
- what are the options?
- what should happen next?

Mica lets you stay at the right level while agents help carry it down into structure and execution. And the layers stay connected — change what you're trying to do, and the plan and tasks update to match.

### Launch strategy: app first, OS second

Classic platform strategy: sell the killer app, let the operating model reveal itself, expand into the broader story after adoption starts.

**Mica = the OS** — the persistent, layered operating layer for human + agent work.

**The launch app = the first thing people urgently want.** A living project space for one serious ongoing effort — for solopreneurs, indie creators, consultants, operators, and ambitious individuals running meaningful work largely on their own.

The app shows what Mica can do without forcing anyone to understand the platform underneath.

---

## Launch Rollout: DGX Spark

### Why DGX Spark
NVIDIA's DGX Spark is the first serious "AI workstation on your desk." The people who buy one are technically fluent, believe in local-first AI, just spent real money on hardware, and are looking for what to actually do with it. They're the ideal early audience.

Mica already supports local LLMs via llama-server. The pieces fit: Mica running entirely on local hardware, agents powered by models on the Spark, everything on your machine, nothing in the cloud.

### Deliverables
1. **Docker package** — `docker pull` and go. Mica server + local LLM backend pre-configured for Spark hardware. No API keys, no cloud accounts, no setup friction.
2. **Sample projects** — Pre-built Mica projects that demonstrate real value in 60 seconds. Not empty templates — living examples with populated cards, agent conversations, and layered work already in progress.
3. **GitHub repo** — Full docs, quickstart guide, architecture overview, contribution guide.

### Sample project ideas
Each project should demonstrate a different kind of layered work:

**Software project** — A product being built: brief, architecture diagram, task list, implementation agent, terminal, decision history. Shows the coding use case with full layers from vision to code.

**One-person business** — A solopreneur running multiple concerns: roadmap, editorial calendar, client pipeline, revenue tracker, weekly priorities. Shows the "effort that keeps its shape" promise.

**Research project** — An investigation in progress: hypotheses, source map, analysis cards, scenario comparisons, findings summary. Shows how thinking accumulates over time.

**Automation/ops project** — A system being monitored: service health cards, alert dashboards, workflow cards, incident log. Shows agents keeping watch on ongoing operations.

### Target audience
- DGX Spark owners looking for compelling local AI applications
- Technically fluent solo operators who want AI that compounds
- Privacy-conscious users who want everything local
- NVIDIA ecosystem developers and enthusiasts

### First 60 seconds experience
1. Pull the Docker image
2. Run one command
3. Open browser → see a populated project with cards already in place
4. Talk to an agent → watch something new appear in front of you
5. Understand immediately: this is different from chat

---

## 1. The Elevator Pitch

Most AI tools help in the moment. You ask, they answer. You prompt, they act. But the larger effort still fragments across chats, documents, tabs, notes, and follow-ups.

Mica gives you a place where important work keeps its shape.

You start with what you want to move forward — a product, a business, a research track, a major initiative. Agents build and maintain the living pieces around it: plans, trackers, calendars, research, decisions, workflows, dashboards, next actions. Everything stays visible, organized, and ready to pick up later.

Instead of AI helping with one thing today and resetting tomorrow, Mica helps the whole effort accumulate over time.

### Shorter version
AI helps in the moment. Mica keeps the whole effort moving.

---

## 2. The Blog Post

### AI helps in the moment. But the effort still falls apart.

This is where a lot of AI value stalls today.

You use AI to draft something, analyze something, plan something, fix something, research something. It helps. Sometimes a lot. But a week later, the larger effort still feels fragile.

The ideas are scattered. The follow-up lives in another thread. The decisions are in a document nobody re-opens. The tracker is stale. The plan drifted. The work happened, but it didn't really add up.

That's the gap Mica is built for.

Mica is not trying to be a smarter chat window. It's the place where work that matters can stay alive.

When you use Mica, you're not just getting output. You're building up a living project:
- the plan
- the research
- the roadmap
- the tracker
- the workflow
- the monitor
- the next action
- the trail of what was built and why
- the changes and the reasons behind them

All of that lives together in one place. Your agents can see it. You can see it. A new agent can pick it up. Someone you're working with can open it and know what's going on without asking.

The point is not "memory." The point is that the effort keeps its shape.

### How Mica changes the way you work with AI

Every AI tool today works the same way: you instruct, it executes. You ask, it answers. One question, one answer, one task at a time.

Mica changes that relationship. Agents aren't just answering your questions — they're working alongside you on the same project. You give them things to do. They come back to you when they need a decision: "I need you to weigh in on this tradeoff before I can move forward" or "this change contradicts the brief — should I update it or revert?" Either side can create things, propose changes, raise concerns, flag risks.

Multiple agents can work on the same project, each focused on a different part. They see each other's work, react to each other's changes — and you're not the bottleneck passing messages between them.

And when an agent runs into something that doesn't have a good way to be shown yet, it creates one. A few dozen lines of code, and there's a new kind of card on your project — purpose-built for exactly this problem. Five minutes ago that capability didn't exist. Now it does.

Your project adapts to the work. A project at the end is richer and more capable than when it started — and that richness carries forward to the next one.

### A day with Mica (solopreneur)

You are running a one-person business and trying to do four things at once: grow a newsletter, ship version 2 of your product, keep client work organized, and test two new ideas before the quarter ends.

In most AI tools, you can get help with any one of these. But you are still the one stitching it all together.

In Mica, you open your project and everything is there: goals, roadmap, editorial calendar, client pipeline, weekly priorities, revenue tracker, notes from the last major decision, a custom comparison card your agent made for evaluating your two new ideas.

You add a new piece of information: subscriber growth dropped, but one client just asked for an upsell path.

Things start updating. Your priorities shift. The content plan adjusts. The revenue tracker flags something worth attention. The product roadmap now reflects the client signal. A decision card appears with tradeoffs laid out.

You didn't restart a conversation. You didn't rebuild anything. You stepped back into a living effort.

### A day with Mica (software project)

8:30 AM. You open Mica and your project is waiting — exactly where you left it Friday. The product brief. The architecture diagram. Three agent conversations mid-thread. The todo list with six items done and four remaining.

You don't re-explain anything. You just start.

"User research came back. Nobody uses the export feature — they screenshot and paste into Slack." You drop a findings card into the project.

Your agent picks it up. Within a minute: *"This contradicts the export flow in the wireframes. The onboarding references it too. Want me to propose alternatives?"* Two cards update. A new one appears — three approaches with tradeoffs, rendered as a decision matrix you can click through.

By 10 AM you've picked an approach. Your implementation agent is scaffolding the replacement. The architecture diagram updated itself to reflect the new flow. You didn't ask for the diagram update — the agent noticed the downstream impact and handled it.

At 3 PM a colleague clones the repo for the first time. He opens it in Mica. Everything is there — the brief, the goals, the decisions, the agent conversations, the diagram that updated itself this morning. He doesn't need a walkthrough. He's looking at it.

### "But I don't start from zero."

Fair. A smart skeptic would push back here — and they'd have a point.

"I have a CLAUDE.md file. I have well-structured docs. My agent reads those on startup. I've turned previous projects into MCP servers. I use Cursor with a rules file. I'm getting things done *right now*. Why do I need another tool?"

And if your current setup works for what you're doing, you probably don't need Mica. Seriously.

CLAUDE.md gives the agent starting instructions. Memory files learn across sessions. MCP servers give agents access to tools and data. Skilled practitioners have assembled effective workflows from these pieces.

So what's actually missing?

CLAUDE.md is a file the agent reads. It's not something you both look at together. You don't open your CLAUDE.md to understand where your project stands — it's instructions for the agent, not a shared view of the work. When the agent makes a decision, that decision doesn't show up as something you can see, navigate, or push back on.

Memory files are private to the agent. You can't see what it remembers. You can't correct a wrong assumption. You can't point someone new at the agent's memory and say "read this to get up to speed."

MCP servers give the agent access to information. They don't give you a place where that information lives *alongside the ongoing work* in a way you can both see and build on.

Docs go stale. Someone writes an architecture doc, it's accurate for two weeks, then the code moves and the doc becomes a lie. Docs don't update themselves when the implementation changes.

All of these tools give the *agent* what it needs. None of them give *both of you* a shared, living place where the project actually lives. You have your view — the IDE, the docs, the Notion pages. The agent has its view — the context window, the memory, the tools. These overlap, but they're not the same thing.

Mica is that shared place. The brief is a card you both see. The diagram updates when the implementation changes. The decision history is right there — visible, navigable, alive.

**Current tools are fine when:** You're working solo on a single task. The project fits in your head. Each session stands on its own.

**Mica adds up when:** Work spans many sessions. Multiple agents or people touch the same project. You need to see the big picture alongside the details. You want agents that notice your changes and keep things consistent without being asked. Someone new needs to pick up the project and be productive right away.

### The bet

Every AI tool today treats what agents produce as a response — text in a chat bubble, code in a file, an answer to a question. Then it's gone.

Mica treats what agents produce as something real — a card that does something useful, that you can come back to, that someone else can pick up, that another agent can build on.

That changes things. The effort accumulates instead of fragmenting. Agents produce things with lasting value, not just replies.

---

## 3. The Landing Page

### Hero

# AI helps in the moment. Mica keeps the whole effort moving.
## The OS for layered work.

A living place for serious ongoing efforts. Plans, trackers, research, workflows, dashboards, decisions, and execution — all together, all kept alive by you and your agents.

[Get Started] [See How It Works]

---

### Launch app

#### Start with one important effort. Run it on Mica.

A living project for one-person businesses, side projects, creative engines, research tracks, and other long-running work that needs to stay coherent over time.

You set the direction. Agents build and maintain the layers. The work keeps its shape.

---

### The problem

#### AI helps. But the value doesn't always add up.

You can use AI to write, plan, research, automate, and execute. But for anything that matters over days or weeks, the effort often falls apart:
- the thinking is scattered
- the tracker drifts
- decisions disappear into threads
- follow-up happens somewhere else
- you become the glue

---

### What Mica does

#### Mica turns scattered AI help into layered, living work.

Ask an agent to research a market — a research layer appears. Ask it to turn the findings into a roadmap — the roadmap layer appears. Ask it to create a launch tracker — now there's a tracker layer. Ask it to monitor something ongoing — a live monitor sits alongside the plan.

Each layer is useful on its own. Together they form the ongoing shape of the effort.

#### Examples
- **One-person business** — roadmap, client pipeline, operating checklist, revenue tracker
- **Content engine** — idea backlog, editorial calendar, drafts, performance tracker
- **Side project** — product brief, architecture, milestones, implementation trail
- **Research track** — hypotheses, source map, analyses, scenario comparisons

---

### How it works

**1. Start with the effort.** Create a Mica project for something you want to keep moving.

**2. Let the layers form.** Agents create plans, trackers, dashboards, workflows, and other useful pieces.

**3. Keep the effort alive.** Come back tomorrow or next week. The work is still there, still structured, still ready to move forward.

---

### How it's different

| | Chat-based AI | AI IDEs | Autonomous Agents | **Mica** |
|---|---|---|---|---|
| Helps in the moment | Yes | Yes | Yes | Yes |
| Keeps the larger effort coherent | No | Partial | Per-task | Yes |
| Work stays visible and organized | No | Code only | Limited | Yes |
| Works across all levels of the effort | No | Implementation only | Limited | Yes |
| Effort builds up over time | No | Partial | Partial | Yes |
| Adapts to exactly the work you need | No | Limited | Limited | Yes — agents create new card types |

---

### Who it's for

People running something meaningful largely on their own — solopreneurs, indie creators, consultants, operators, ambitious individuals balancing multiple important efforts.

You're not looking for a better chatbot. You're looking for a place where your effort stays alive between sessions.

---

### Under the hood

- **One primitive** — Everything is a card. Projects are cards that hold cards. Composition is recursive.
- **Layered persistence** — Work lives in `.mica/` as flat files, versioned in git.
- **Extensible by design** — New capability = new `render.js`. No framework changes needed.
- **Reactive agents** — Agents notice changes and keep things consistent across the project.
- **Model-agnostic** — Claude, local LLMs, any OpenAI-compatible endpoint.
- **Zero lock-in** — Delete `.mica/` and your project is untouched.

[Get Started with Mica]

---

## 4. For the AI-Savvy Technologist

The current AI stack is increasingly good at individual actions and increasingly weak at durable, layered work.

A skilled user can assemble a lot today — CLAUDE.md, Cursor rules, MCP servers, good docs, memory files, structured repos. Those mainly improve the agent's starting position. They don't create a persistent place where you and the agents are looking at the same evolving project.

Mica does.

### The important architectural idea
The canvas is not a view over the work. The canvas **is** the work.

Cards are the units of persistence, utility, and coordination. They are also the units of extension.

One abstraction: the *card* — a sandboxed, renderable, interactive unit. Document, diagram, terminal, dashboard, agent — all cards. Cards compose recursively (a canvas is a card containing cards). Agents create cards dynamically. Everything persists as flat files in `.mica/`, versioned in git.

### What makes Mica different technically

**Shared, visible project state.** Not just agent memory. Not just docs. Not just chat history. A place where you and agents see the same work — navigable, editable, alive.

**Fluid movement across levels.** You don't start in implementation. Mica lets work begin at "what am I trying to do," move down into structure and execution, and stay connected throughout. Change the goal and the plan and tasks update to match.

**Agents as collaborators.** Not request-response. Agents come back to you with questions and decisions. You delegate to them. Multiple agents share the same project — product, design, implementation — each handling different concerns, coordinating through shared files and events.

**Agents extend the project at runtime.** When an agent encounters a problem the current card vocabulary can't express, it writes a new `render.js` — a new card class — and drops it into `.mica/.card-classes/`. Card classes run in V8 isolates (32MB, zero OS access), can expose server-side functions and bidirectional channels. The project grows new capabilities as the work demands.

**Reactive coherence.** Agents triage file changes — cheap Haiku pass for relevance, full agent reaction with tools. Your edits ripple through the project without you asking. Not "the agent remembers your preferences." The agent is watching the work and keeping things consistent.

**Extension without deployment.** Card class = `render.js`. Project-scope > workspace-scope > built-in resolution. Promotion is copying a directory. No package manager, no registry, no install step. The file is the extension.

### Stack
Express + WebSocket, per-project Docker containers as blast radius, V8 isolate pool for card sandboxing, unified ChannelManager (transport-agnostic, sessions bound to file lifecycle not connection state), pluggable agent providers (Claude SDK, llama-server, OpenAI-compatible). All state as flat files.

### Honest comparison
A skilled practitioner with CLAUDE.md, well-structured docs, MCP servers, and Cursor rules has a lot of this handled — for themselves, for one agent, in one session at a time. What they don't have is a shared view of the project (you and the agent looking at the same thing), reactive updates (the agent keeping things consistent without being asked), multi-agent coordination (multiple agents working the same project), or a project that grows new capabilities as agents create new card types. For solo, single-session work, the current stack is genuinely good. For work that spans sessions, agents, and people — it's the difference between passing notes and being in the same room.

Mental model: Emacs meets a whiteboard, but your Emacs packages can be written by your AI collaborators while you work.

---

## 5. Honest Assessment

### When Mica fits
- The effort spans time and should stay coherent between sessions
- There are multiple moving parts that need to stay connected
- You want to stay at the right level, not get pulled into details too early
- Agents should keep carrying things forward between sessions
- Someone new — person or agent — needs to pick up existing work
- The project should grow new capabilities as the work demands

### When it doesn't
- You need a one-off answer
- The task is small and self-contained
- Your current setup already handles the whole thing well enough
- There's no meaningful continuity to preserve

### The skeptic's strongest challenges

**"Agents creating new card types sounds cool in a demo. In practice it'll be fragile."** Fair. AI-generated code will sometimes be buggy. V8 isolate sandboxing limits the damage — a bad card can't crash the system. Cards are just files — you can inspect them, fix them, delete them. The project is resilient to bad cards in a way a monolithic app isn't resilient to bad features. But it does require the user to have enough judgment to know when something's good enough — which is why the early audience is technically fluent.

**"Multi-agent coordination is a research problem, not a product."** Partly right. But Mica's approach is simpler than it sounds: agents share state through files and react to file changes. No consensus protocol, no routing algorithm. Just a shared project and agents that notice when things change. It works because the mechanism is the simplest possible one.

**"Canvas is a solution looking for a problem."** ChatGPT Canvas failed because it was a viewing layer bolted onto chat — no persistence, no composition, no project integration. Mica's canvas isn't a feature on top of chat. It's the main thing. And `.mica/` is just a directory — simple, portable, version-controlled, removable. The innovation isn't the storage. It's what lives there: agents that collaborate, work that stays connected, and a project that grows with the effort.

### The message we're moving toward

Not: "Your AI forgot everything."

Not: "Persistent context for your team."

**"AI helps in the moment. Mica keeps the whole effort moving."**

And internally: **Mica is the OS for layered work. The launch app is a living project for one serious ongoing effort.**

---

## Appendix A: Competitive Landscape

### AI coding tools
- **Cursor** — AI IDE, edit-centric, $20/month. Strong multi-file reasoning. No project-level view, no persistence of thinking beyond code.
- **Windsurf/Cascade** — AI IDE with "flow awareness" and Memories feature. Agent learns codebase conventions. Still IDE-bound, what the agent knows is private to the agent.
- **Claude Code** — Terminal-first, reasoning-first. Leads SWE-bench. Superior for complex architectural work. No visual project view, no multi-agent coordination.
- **GitHub Copilot** — Ecosystem-integrated. Enterprise trustworthiness. Not on the cutting edge of what AI can do with code.
- **Devin** — Autonomous agent. Pivoted from full autonomy to collaboration (v2.0). Task completion rates modest (~15-30%). Price dropped from $500 to $20/month.
- **Kiro (AWS)** — Spec-driven IDE. Requirements → code → tests → deployment. Forces clarity before coding.
- **Google Antigravity** — Agent-first IDE with "manager view" for coordinating parallel agents. Early stage.

### Agent frameworks
- **OpenClaw** — Local-first autonomous agent via messaging platforms. 100K GitHub stars. Creator joined OpenAI. Appeal: "AI that actually does things."
- **Hermes** — Self-improving agent with persistent cross-session memory. 40+ tools. Model agnostic.
- **Aider** — Open-source terminal pair programmer. Strong git integration and repository mapping.
- **Cline** — Open-source IDE agent. Zero-trust architecture. 5M+ VS Code installs.

### Canvas/collaboration tools
- **ChatGPT Canvas** — Viewing layer bolted onto chat. No persistence, no composition, no project integration.
- **Miro AI Workflows** — Enterprise canvas for visual AI automation. Business process focused, not dev focused.

### Multi-agent orchestration
- **LangGraph** — Agent framework as stateful graphs. Production reliability but requires building everything yourself.
- **CrewAI** — Role-based multi-agent with shared memory. Good for prototyping.

### The gap Mica fills
Nobody provides a persistent, layered place where you and your agents are looking at the same evolving project. AI IDEs solve code editing. Autonomous agents solve delegation. Canvas tools solve viewing. Multi-agent frameworks solve orchestration. None solve the compound problem of work that needs to stay coherent across time, across levels, across the people and agents involved.

## Appendix B: Market Data

### AI adoption (2026)
- ChatGPT: 2.8B monthly users, 900M weekly, $25B annualized revenue
- Gemini: 750M monthly users
- Claude: 30M monthly consumer users, 11.3M daily, $19B ARR
- Grok: 50M monthly users
- 75% of knowledge workers use AI regularly; 46% started in last 6 months

### The value gap
- 95% of enterprises see zero measurable ROI on AI investment (MIT)
- Harvard "jagged frontier": AI within capabilities = 40% improvement; outside = 19% worse
- METR study: experienced developers 19% slower with AI tools, but believed they were 20% faster
- Top user frustrations: can't remember conversations, inconsistent quality, work doesn't carry over

### The paradigm shift
- Steve Yegge/Gene Kim: "The IDE is dead" (late 2025) — overstated, but the monolithic editor is breaking apart
- Gartner: 1,445% surge in multi-agent system inquiries (2024-2025)
- Anthropic: 60% of engineering work involves AI, but only 0-20% fully delegated
- 75% of Replit users never write code — non-developer creators growing fast
- Spec-driven development becoming standard practice (Kiro, GitHub Spec Kit, Thoughtworks)
- MCP: 97M monthly SDK downloads, 5,800+ community servers (becoming the standard way agents connect to tools)
- Code review is the new bottleneck — 47% of developers rank it #1 critical skill

### Audience expansion opportunity
- No-code/low-code market: $45B+
- Lovable raised at $6.6B valuation
- 281M people used AI tools in 2024; 1.1B expected by 2031
- The 5% getting compounding value have built their own systems (CLAUDE.md, MCP, rules files)
- Everyone else gets good-but-fleeting help — useful in the moment, gone by next session
