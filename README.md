# Mica

**A shared surface where humans and AI agents collaborate to build products.**

Today when you work with AI to build software, the guidance disappears. You chat with an agent, give it direction, it writes code. The code gets committed — but the briefs, the decisions, the "make onboarding feel like a conversation not a form" — that lives in ephemeral chat history. Next session, you start over.

Mica fixes this. It's a persistent, extensible canvas where:

- **Both sides contribute as peers.** You sketch an idea, the agent builds it out. The agent asks you to clarify requirements instead of guessing. Either side creates artifacts, asks questions, assigns work to the other.
- **The work and the conversation live together.** Diagrams, wireframes, running apps, code — rendered natively on the canvas, not as text in a chat window.
- **The recipe persists.** Briefs, goals, decisions, and context are captured in `.mica/` inside your project repo, versioned in git. Any agent or teammate picks up with full context.
- **Projects stay sovereign.** Mica connects to your existing git repos via a `.mica/` directory. Remove it and the project is untouched. No lock-in.
- **Multiple projects at once.** Manage a portfolio of projects from one surface — see which need attention, which are stuck, which are shipping.
- **Everything is extensible.** The canvas is built from composable cards. New card classes add new capabilities, like Emacs packages.

## Quick Start

```bash
npm install
npm run dev
```

The dev server starts the Vite frontend and the Express backend (port 3001).

## Documentation

- **[SPEC.md](SPEC.md)** — Product definition, the card model, collaboration model, signal system
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — Project-first model, `.mica/` directory, git integration, container isolation
- **[TEST_PLAN.md](TEST_PLAN.md)** — Verification checklist for project infrastructure
- **[old_thoughts/](old_thoughts/)** — Archived reference material from earlier design phases
