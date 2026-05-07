# Putting HTTPS in front of Mica

Mica's container speaks plain HTTP and WebSocket on a single port.
TLS termination is left to whatever reverse proxy you put in front
of it. This document walks through four common patterns; pick the
one that fits your setup.

You need HTTPS if:
- You access Mica from a phone (iOS Safari requires a secure
  context for `getUserMedia`, `MediaRecorder`, and reliable audio
  playback).
- You expose the canvas to teammates over the internet.
- Your browser blocks features (clipboard, screenshare, push
  notifications) that require a secure origin.

You don't need HTTPS for local desktop dev — `http://localhost` is
a "secure context" by default in all major browsers.

## What Mica expects from the proxy

- **HTTP/1.1 with WebSocket upgrade** on `/ws/cards`. Most reverse
  proxies pass `Upgrade: websocket` automatically; some need an
  explicit knob.
- **Long-lived connections** — voice TTS streaming and chat agent
  turns can run for minutes. Set generous read/idle timeouts.
- **Same-origin** for the WS — Mica's frontend opens
  `wss://<your-host>/ws/cards`, derived from `location.protocol +
  location.hostname`. So whatever hostname your proxy serves at,
  the WS works.
- **No path rewriting** — the frontend assumes `/api` and `/ws`
  paths reach the backend untouched.

That's it. No SNI tricks, no gRPC, no HTTP/2 push, no special
headers required. A vanilla reverse proxy works.

---

## Pattern 1 — Tailscale Serve on the host (recommended)

Best when: you're running Mica for yourself or a small team and
everyone using it is on a Tailscale tailnet (free, easy).

```bash
# On the host running Mica:
docker run -d --name mica -p 5173:5173 -p 3002:3002 mica:latest

# One-time: enable MagicDNS + HTTPS Certificates in the Tailscale
# admin console (https://login.tailscale.com/admin/dns).

# Front Mica with HTTPS:
tailscale serve --bg https / proxy 5173

# Print the URL:
tailscale serve status
# → https://<machine>.<tailnet>.ts.net (tailnet only)
```

The URL works on any device that's on your tailnet. Add team
members by inviting them to the tailnet; share with the iPhone by
installing the Tailscale app and signing in.

To stop: `tailscale serve reset`. (Note: this clears ALL serve
configs on the host, not just Mica's.)

**Pros:**
- Zero cert management — Tailscale handles renewal.
- Free for individuals + small teams.
- Real cert trusted by browsers / iOS without manual install.
- Internal-only (not public-internet) by default.

**Cons:**
- Each user needs a Tailscale account + the app installed.
- 1 GB/month bandwidth on the free tier (plenty for voice).
- One serve config per host on free tier.

**For public exposure** — flip from `serve` to `funnel`:
```bash
tailscale funnel --bg 5173
```
Same URL, now reachable from the public internet. Useful for demos.

---

## Pattern 2 — Caddy with Let's Encrypt

Best when: you have a domain name pointed at your host and want a
public URL with a real CA-issued cert.

`/etc/caddy/Caddyfile`:
```caddyfile
mica.example.com {
  reverse_proxy localhost:5173 {
    # WebSocket and long-lived requests:
    header_up X-Forwarded-Host {host}
    transport http {
      read_timeout 600s
      write_timeout 600s
    }
  }
}
```

```bash
# Run Mica:
docker run -d --name mica -p 5173:5173 -p 3002:3002 mica:latest

# Install Caddy: https://caddyserver.com/docs/install
sudo systemctl enable --now caddy
```

Caddy handles cert provisioning + renewal automatically via Let's
Encrypt. Your DNS A record needs to point at the host's public IP,
and ports 80 + 443 must be reachable for the ACME HTTP-01
challenge.

**Pros:**
- Real cert from a public CA.
- One file of config, no daemon flags.
- Auto-renewal handled by Caddy.

**Cons:**
- Requires a public domain.
- Public-internet exposure (use `basicauth` or Caddy's
  `forward_auth` directive to add an auth layer if needed).

---

## Pattern 3 — docker-compose with Caddy sidecar

Best when: you want a self-contained multi-container deploy where
Caddy and Mica come up together.

`docker-compose.yml`:
```yaml
services:
  mica:
    image: mica:latest
    expose: ["5173", "3002"]
    networks: [internal]

  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    networks: [internal]
    depends_on: [mica]

volumes:
  caddy_data:
  caddy_config:

networks:
  internal:
```

`Caddyfile`:
```caddyfile
mica.example.com {
  reverse_proxy mica:5173
}
```

Caddy resolves the `mica` hostname via Docker's internal network.
No host-port mapping for Mica required — Caddy is the only thing on
80/443.

---

## Pattern 4 — Cloud load balancer (AWS / GCP / Azure)

Best when: you're deploying Mica on managed infrastructure.

Each cloud has its own cert-management story:
- **AWS** — Application Load Balancer with ACM-issued cert,
  forwarding to the Mica container's target group on port 5173.
- **GCP** — HTTPS Load Balancer with Google-managed cert, backend
  service hits the GCE VM / GKE pod port 5173.
- **Azure** — App Gateway with managed cert, backend pool on the
  container's port 5173.
- **Kubernetes (any cloud)** — `Ingress` resource with an `IngressClass`
  that supports TLS, cert-manager for Let's Encrypt or your CA.

Mica-side requirements are the same: the container exposes port
5173, the LB does TLS, the LB upstream is HTTP. WebSocket support
needs to be turned on (some LBs default to HTTP/1.1 without
upgrade; check the LB's WS settings).

---

## Why not bundle Caddy/nginx into the Mica container?

Standard Docker pattern is "single concern per container" —
Mica's container does Mica, the proxy container does TLS. This
gives:
- **Choice** — users pick the proxy that fits their environment.
- **Cleaner cert management** — certs live in the proxy's volume,
  not bound to Mica's lifecycle. Renewals don't restart Mica.
- **Composability** — the same Mica container works behind
  Tailscale, Caddy, nginx, k8s ingress, cloud LB — no rebuild.
- **Simpler scaling** — you can run multiple Mica replicas behind
  one TLS terminator, or replace the proxy without touching Mica.

If you want a single-container quickstart, run Caddy + Mica
together via docker-compose (Pattern 3) — it's the same outcome
without conflating the responsibilities into one image.

---

## Checklist for any HTTPS path

After putting a proxy in front, check:

| Test | Expected |
|---|---|
| Open `https://<your-host>/` in a browser | Mica loads |
| DevTools → Network → WS | `wss://<your-host>/ws/cards` shows green |
| iOS Safari → tap the mic on a `.voice` card | Permission prompt fires |
| Speak a sentence | Transcript appears, voice replies, audio plays |
| Browser console | No `Mixed Content: ... ws://...` blocks, no CSP errors |

If the WS connection fails with a CSP block, ensure
`server/index.ts`'s `connect-src` directive includes `wss:` and
`https:` schemes — recent versions of Mica already include this.

If WS connects but disconnects after ~60 seconds, your proxy's
idle timeout is too short. Tailscale Serve and Caddy default to
generous timeouts; nginx and many cloud LBs default to 60s and
need explicit configuration.
