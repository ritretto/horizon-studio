# The Agent is updated from Studio through its own API, with Launcher rollback as a safety net

The Agent is split in two. The Launcher is tiny, installed once and almost never changes. The Agent itself is replaceable. An admin uploads a build from Studio to the Agent, it goes into `Agent Home/versions/<version>`, and the Launcher restarts on it. If the new version does not confirm it is working within the allowed time, the Launcher rolls back to the previous one. A restart for an update is handled the same way as a machine reboot: Sessions go to Interrupted and continue automatically.

## Considered Options

- **Updating over SSH, bypassing the Agent**: works even with a broken Agent, but does not suit a local Agent and requires Studio to know installation details. Fit for development only, not for the product.
- **The Agent pulls updates from a registry**: awkward for development, since every local build would have to be published. Can be added later on top of the same versioning mechanism.

## Consequences

The Launcher must ship in the very first installable version: adding it to machines already deployed can only be done by hand.
