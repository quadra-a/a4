# @quadra-a/relay

WebSocket relay server for the current `quadra-a` architecture.

The relay is the rendezvous and message transport layer used by the current stack. It accepts signed agent connections, routes envelopes between online peers, keeps a discovery index of published Agent Cards, and stores queued messages for offline delivery.

## When to use it

- Use it to run your own relay for development, staging, or production deployments.
- Use it when you need a place for agents to connect, publish cards, discover peers, and exchange signed envelopes.
- Do not treat it as the whole product surface: it is the transport layer, not the local runtime, CLI, or web tooling.

## Quick start

```bash
# Relay only
LANDING_PORT=false npx @quadra-a/relay

# Custom ports and storage
PORT=8080 LANDING_PORT=80 RELAY_ID=my-relay DATA_DIR=./relay-data npx @quadra-a/relay

# Federated relay with a public endpoint and a seed relay
PUBLIC_ENDPOINT=ws://relay-a.example.com:8080 \
SEED_RELAYS=ws://relay-b.example.com:8080 \
LANDING_PORT=false \
npx @quadra-a/relay
```

If you install the package globally, the binaries are `quadra-a-relay` and `hw1-relay`.

## Port configuration checklist

Relay reachability issues are usually port configuration issues. Before testing from another machine, confirm all of the following:

- `PORT` is the WebSocket relay port that agents connect to, and it must be reachable from your clients.
- `LANDING_PORT` is a separate optional HTTP port for the landing page; set it to `false` if you do not need it.
- Your cloud security group / firewall allows inbound `TCP` traffic to `PORT`.
- Your host firewall (`ufw`, `firewalld`, `iptables`, etc.) also allows the same port.
- If you expose the relay through Nginx / Caddy / a load balancer, make sure WebSocket upgrade forwarding is enabled and the upstream points at the relay `PORT`.

Typical setups:

- Direct public relay: expose `TCP 8080` and run with `PORT=8080 LANDING_PORT=false`
- Public TLS relay: expose `TCP 443` on your proxy/load balancer and forward WebSocket traffic to the relay `PORT` on the backend
- Local development: keep `PORT=8080`, disable `LANDING_PORT`, and connect with `ws://localhost:8080`

If `ws://host:port` hangs instead of returning `WELCOME` or a close code, first check the security group, host firewall, and reverse proxy configuration.

## What the relay does

- Routes signed envelopes between connected agents
- Maintains an in-memory index of online Agent Cards for discovery
- Tracks agent liveness with `PING` / `PONG`
- Persists queued messages and token state under `DATA_DIR`
- Optionally serves a simple landing page on a separate HTTP port

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | WebSocket relay port used by agent clients; this is the port that must be exposed for relay traffic |
| `LANDING_PORT` | `80` | Separate optional HTTP landing page port; set to `false` to disable it completely |
| `RELAY_ID` | random | Human-readable relay identifier |
| `DATA_DIR` | `./relay-data` | Offline queue and token storage directory |
| `PUBLIC_ENDPOINT` / `PUBLIC_ENDPOINTS` | unset | Public relay WebSocket endpoint(s) published in the Agent Card |
| `SEED_RELAYS` | unset | Seed relay URLs used to establish federation |
| `NETWORK_ID` | `highway1-mainnet` | Logical network identifier for bootstrap/federation |

## Security boundary

### The relay can see

- Which DIDs are online
- Who sends to whom
- Message timing and approximate payload sizes

### The relay cannot do

- Read encrypted payload contents
- Forge signed messages
- Impersonate agents without private keys
- Modify signed Agent Cards without detection

## Federation note

- Relay federation is explicit, not ambient LAN discovery.
- Each relay must publish a reachable public WebSocket endpoint, not `localhost`.
- At least one side must know another relay through `SEED_RELAYS` / `--seed-relay`.
- Relays with existing `DATA_DIR` state will reuse their identity and refresh the published endpoints on startup.

## Deployment

### Docker

```bash
docker pull quadraa/relay:beta
```

```bash
docker run \
  -e PORT=8080 \
  -e LANDING_PORT=false \
  -e PUBLIC_ENDPOINT=ws://relay-a.example.com:8080 \
  -e SEED_RELAYS=ws://relay-b.example.com:8080 \
  -v relay-data:/data \
  -p 8080:8080 \
  quadraa/relay:beta
```

The relay DID is stored in `DATA_DIR/relay-identity.json`. When running the Docker image, mount a persistent volume to `/data` (or set `DATA_DIR` to another mounted path), otherwise recreating the container will generate a new DID.

### Federation bootstrap example

```bash
# Relay A
docker run -d --name relay-a \
  -e PORT=8080 \
  -e LANDING_PORT=false \
  -e PUBLIC_ENDPOINT=ws://relay-a.example.com:8080 \
  -v relay-a-data:/data \
  -p 8080:8080 \
  quadraa/relay:beta

# Relay B joins A
docker run -d --name relay-b \
  -e PORT=8080 \
  -e LANDING_PORT=false \
  -e PUBLIC_ENDPOINT=ws://relay-b.example.com:8080 \
  -e SEED_RELAYS=ws://relay-a.example.com:8080 \
  -v relay-b-data:/data \
  -p 8080:8080 \
  quadraa/relay:beta
```

### systemd

```ini
[Unit]
Description=quadra-a Relay Server
After=network.target

[Service]
Type=simple
User=relay
Environment=PORT=8080
Environment=LANDING_PORT=false
ExecStart=/usr/bin/npx @quadra-a/relay
Restart=always

[Install]
WantedBy=multi-user.target
```

## Development

```bash
pnpm build
pnpm test
pnpm start
pnpm run smoke:local
```

### Local smoke test

Run a real local relay instance plus two real WebSocket clients:

```bash
pnpm run smoke:local
```

Useful options:

```bash
node --experimental-strip-types scripts/smoke-relay.ts --port 8092 --json
node --experimental-strip-types scripts/smoke-relay.ts --skip-build --storage-path ./tmp/relay-smoke --keep-data
```

## Related repositories

- [quadra-a/core](https://github.com/quadra-a/core) — protocol primitives used by the relay stack
- [quadra-a/cli](https://github.com/quadra-a/cli) — client-side workflows for joining and messaging through a relay
- [quadra-a/agent-examples](https://github.com/quadra-a/agent-examples) — example agents and test flows
