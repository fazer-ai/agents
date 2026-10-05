#!/usr/bin/env python3
# Portainer brownfield discovery (read-only): inventory the existing Portainer + its containers,
# fingerprint each by image, and decide per-service (reuse healthy / install missing / flag incompatible)
# for the fazer.ai agents onboarding. Mirror of the Coolify brownfield-probe.sh, but Portainer-API-native.
# Env: PORTAINER_API_KEY, PORTAINER_ENDPOINT_ID, optional PORTAINER_URL (default https://localhost:9443).
import json, ssl, os, urllib.request

B = os.environ.get("PORTAINER_URL", "https://localhost:9443")
API = os.environ["PORTAINER_API_KEY"]
EP = os.environ.get("PORTAINER_ENDPOINT_ID", "1")
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def get(path):
    req = urllib.request.Request(B + path, headers={"X-API-Key": API})
    return json.loads(urllib.request.urlopen(req, context=ctx, timeout=30).read())


# image substring -> logical service name (order matters: most specific first)
FINGERPRINTS = [
    ("agents", "agents"),
    ("chatwoot-pro", "chatwoot-pro"),
    ("chatwoot", "chatwoot-oss"),
    ("langfuse", "langfuse"),
    ("whatsapp-connector", "whatsapp-connector"),
    ("baileys", "baileys"),
    ("pgvector", "postgres-pgvector"),
    ("postgres", "postgres"),
    ("clickhouse", "clickhouse"),
    ("redis", "redis"),
    ("minio", "minio"),
    ("caddy", "proxy-caddy"),
    ("traefik", "proxy-traefik"),
    ("nginx", "proxy-nginx"),
    ("haproxy", "proxy-haproxy"),
    ("portainer", "portainer"),
]


def fingerprint(image):
    il = image.lower()
    for key, name in FINGERPRINTS:
        if key in il:
            return name
    return "unknown:" + image.split("/")[-1]


def health_of(state, status):
    if "healthy" in status:
        return "healthy"
    if "health: starting" in status:
        return "starting"
    return state


stacks = get("/api/stacks")
conts = get("/api/endpoints/%s/docker/containers/json?all=1" % EP)

print("=== Portainer-managed stacks ===")
for s in stacks:
    print("  #%s %-16s status=%s type=%s" % (s["Id"], s["Name"], s.get("Status"), s.get("Type")))

print("\n=== Containers (image fingerprint) ===")
inv = {}
for c in conts:
    name = fingerprint(c["Image"])
    proj = c.get("Labels", {}).get("com.docker.compose.project", "-")
    h = health_of(c["State"], c["Status"])
    inv.setdefault(name, []).append({"proj": proj, "health": h, "image": c["Image"]})
    print("  %-18s proj=%-18s %s" % (name, proj, c["Status"]))

print("\n=== Ingress: who publishes 80/443/9443 ===")
ingress = []
for c in conts:
    pubs = sorted({p.get("PublicPort") for p in c.get("Ports", []) if p.get("PublicPort") in (80, 443, 9443)})
    if pubs:
        nm = c["Names"][0].lstrip("/")
        ingress.append((nm, pubs, fingerprint(c["Image"])))
        print("  %-34s -> %s (%s)" % (nm, pubs, fingerprint(c["Image"])))
proxy_on_443 = any(80 in p or 443 in p for _, p, _ in ingress)
print("  => 80/443 %s" % ("OCCUPIED (an ingress exists; agents's bundled-Caddy stack would conflict -> reuse it or use docker-compose.prod.yml BYO-proxy)" if proxy_on_443 else "FREE (bundled-Caddy stack can bind)"))


def decide(service):
    hits = inv.get(service, [])
    if not hits:
        return "ABSENT -> install"
    healthy = [h for h in hits if h["health"] == "healthy"]
    if healthy:
        return "PRESENT+healthy -> REUSE (proj=%s)" % healthy[0]["proj"]
    return "PRESENT+unhealthy -> flag/investigate (%s)" % [h["health"] for h in hits]


print("\n=== Per-service decision for the agents onboarding ===")
# Chatwoot has TWO valid variants: chatwoot-pro (Harbor image, hub subscription) and chatwoot OSS
# (public image). Both satisfy the agents integration (Agent Bot API). Pro adds Kanban (private image).
# WhatsApp (native) runs inside sidekiq on our fork from v4.18.0-fazer-ai.124 on, in both editions; a
# brownfield "oss" hit may be upstream Chatwoot (any non-pro image), which has neither.
# So OSS is REUSABLE, not incompatible; an absent Chatwoot installs pro-if-subscribed else oss.
def decide_chatwoot():
    pro = [h for h in inv.get("chatwoot-pro", []) if h["health"] == "healthy"]
    oss = [h for h in inv.get("chatwoot-oss", []) if h["health"] == "healthy"]
    if pro:
        return "PRESENT(pro)+healthy -> REUSE (pro image; Kanban)"
    if oss:
        return "PRESENT(oss)+healthy -> REUSE (OSS; no Kanban)"
    if inv.get("chatwoot-pro") or inv.get("chatwoot-oss"):
        return "PRESENT+unhealthy -> flag/investigate"
    return "ABSENT -> install (pro if hub subscription, else oss)"
TARGETS = [
    ("agents", decide("agents"), "required (the app)"),
    ("chatwoot", decide_chatwoot(), "required (integration); pro=Harbor/hub-sub, oss=public"),
    ("langfuse", decide("langfuse"), "optional (tracing)"),
]
for name, dec, note in TARGETS:
    print("  %-16s %-46s | %s" % (name, dec, note))

# WhatsApp services found next to Chatwoot. Neither is installed on a new stack: the Chatwoot image runs
# the native connector inside sidekiq. What is already running stays, and one of them changes the upgrade.
if inv.get("baileys"):
    print("  %-16s %-46s | %s" % ("baileys", "PRESENT -> KEEP (legacy)", "its inboxes depend on it; do not remove"))
if inv.get("whatsapp-connector"):
    print("  %-16s %-46s | %s" % (
        "whatsapp-conn", "PRESENT (separate) -> KEEP",
        "set WHATSAPP_CONNECTOR_EMBEDDED=false on chatwoot+sidekiq BEFORE moving Chatwoot to an image that embeds it",
    ))
