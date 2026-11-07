# Studio connects to the Agent, and the Agent listens only on localhost

The connection goes from Studio to the Agent, not outbound from the Agent to Studio (as with GitHub Actions runners). The user creates a Connection in Studio to a specific Agent. An Agent always listens only on `127.0.0.1`, so a remote Agent is reachable only through an SSH tunnel with keys. Studio opens, maintains and reconnects the tunnel itself. This way one Agent serves any number of Studios without knowing their addresses, and SSH takes care of network security entirely.

## Considered Options

- **Agent → Studio (outbound WebSocket)**: works behind NAT with no tunnels, but ties the Agent to the addresses of specific Studios. Rejected.
- **Direct connection in a trusted subnet**: an open port that can start AI remotely is available to anyone on the network. Rejected; TLS protection for the channel can be added later.
