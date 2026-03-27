# Archived from SPEC.md — 2026-03-27. Reference material, not current spec.

## Multi-Surface Architecture

### Design Principle

Mica treats each connected display as a **surface** with unique capabilities. Rather than mirroring the same interface across screens, each surface plays to its strengths. The system is aware of all connected surfaces and orchestrates them as a unified workspace.

### Surface Types and Strengths

| Surface | Primary Strength | Role in Mica |
|---------|-----------------|--------------|
| **Tablet** (iPad) | Maximum interactivity — touch, stylus, voice, keyboard | Primary collaboration surface. Where direct manipulation, sketching, and focused work happen. |
| **Large display** (TV/monitor) | Screen real estate, shared viewing | Expanded workspace for complex layouts. Context view showing broader surroundings of what the tablet is focused on. Independent reference that holds stable while the tablet navigates. |
| **Projection wall** | Massive real estate, ambient visibility | Portfolio-level overview. War room presentations. Ambient project health dashboard visible from across a room. |
| **Desktop** (Mac/PC) | Keyboard, precision, developer tools | Deep editing, implementation review, precise text-heavy work. Integration with local development environments. |
| **Phone** | Portability, always-on | Quick triage, escalation review, approvals on the go. Notification surface for urgent attention items. |

### Surface Capabilities Declaration

Each surface registers its capabilities when it connects:
- **Input methods** — touch, stylus, keyboard, voice, mouse, trackpad
- **Screen characteristics** — size, resolution, pixel density, orientation
- **Interaction distance** — handheld (tablet/phone), desk distance (monitor), room distance (TV/projection)
- **Mobility** — stationary vs. portable

### Multi-Surface Coordination

When multiple surfaces are active, they are aware of each other and coordinate:
- **Synchronized mode** — surfaces show the same canvas at different zoom levels or viewport positions
- **Split mode** — each surface shows a different layer
- **Extended mode** — surfaces form one continuous workspace
- **Independent mode** — each surface navigates freely

### Voice Across Surfaces

Voice input is not bound to the tablet. Any surface with a microphone can receive voice — enabling hands-free interaction with the large display or projection while the user's hands are on the tablet.

### Future Surface Considerations

The multi-surface architecture should not preclude:
- **AR/VR headsets** — spatial computing surfaces where layers could become literal spatial depth
- **E-ink displays** — persistent, low-power surfaces showing project status
- **Collaborative multi-tablet** — multiple humans each with their own tablet, seeing shared and private views
