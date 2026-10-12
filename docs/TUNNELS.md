# Tunnels: reaching a company's internal systems

TERMINAL connectors reach public internet addresses only. A system that lives
inside a company's own network (SAP Business One, Odoo on premises, an
internal REST API, a PostgreSQL server) is reached through a **zero-trust
tunnel**: the company runs a small connector next to the system, the tunnel
provider carries the traffic, and nothing in the company's firewall is
opened. ETNA does not use VPNs. (A PrintStream agent installed at the company
is planned for later.)

There are two ways to use a tunnel, depending on what the company's tunnel
publishes.

## A. A public hostname behind Cloudflare Access (HTTP APIs)

Best for HTTP systems (REST APIs, SAP B1 Service Layer, Odoo).

1. **The company** installs `cloudflared` on a machine that can reach the
   system and creates a tunnel in its Cloudflare account (Networks →
   Tunnels), publishing the system under a hostname such as
   `sap-api.company.co.id` (HTTPS).
2. **The company** protects that hostname with Cloudflare Access: an Access
   application with a **Service Auth** policy and a **service token** made for
   PrintStream (Access → Service credentials). It keeps the token's client ID
   and secret.
3. **In PrintStream**, a member who manages connections creates the
   connection with the public hostname as its address and, under
   **Advanced**, the *Cloudflare Access client ID* and *client secret*. They
   are sent with every request to that hostname only (never to token
   endpoints or other hosts) and the secret is sealed like any other.

ETNA needs to do nothing: the address is public.

## B. An internal host:port reached through the tunnel (any protocol)

For systems that must not get a public hostname, or that are not HTTP
(PostgreSQL). The tunnel arrives at **one internal address and port** that
ETNA's server can reach, for example a Cloudflare WARP connector or
`cloudflared` private network route that makes `10.20.0.5:5432` reachable from
ETNA's server.

1. **The company and ETNA** agree the route: the company publishes its
   private network (e.g. `10.20.0.0/24`) through its tunnel; ETNA's server
   joins it (WARP connector or the provider's equivalent). Test from ETNA's
   server that the host and port answer, and only those.
2. **A super admin** opens **Admin → Governance → Tunnels**, finds the
   company and allows exactly that `host:port` (e.g. `10.20.0.5:5432`) with
   its purpose. The entry applies to **that company's connections only**;
   other companies still cannot reach it. Adding and removing need a fresh
   two-factor sign-in and are kept in the security log
   (`NETWORK_ALLOW_ADDED`, `NETWORK_ALLOW_REMOVED`).
3. **In PrintStream**, the company's member creates the connection with that
   address. Plain HTTP and databases without TLS are accepted only for such
   allowed internal addresses; HTTPS and TLS are still recommended.

Never allowed, whatever is entered: the server itself (`localhost`,
`127.0.0.0/8`, `::1`), `0.0.0.0/8`, link-local and cloud metadata addresses
(`169.254.0.0/16`, `fe80::/10`). A tunnel connector therefore runs on another
machine or network address than ETNA's own loopback.

## Removing access

* The company deletes the service token or the tunnel in its own account:
  PrintStream's connections stop at once.
* A super admin removes the `host:port` in **Tunnels**.
* The company's members remove the connection in TERMINAL → Connections.

## Notes

* **Connector networks** (the list above **Tunnels**) still exists for
  addresses every company may reach (rare: ETNA's own internal services).
  Prefer per-company tunnel entries.
* Entries are host:port only; a whole network cannot be allowed per company.
* Not yet verified with a live Cloudflare account; the guard's checks are
  covered by tests.
