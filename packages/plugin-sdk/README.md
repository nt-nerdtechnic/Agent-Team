# `@navide/plugin-sdk`

The public, framework-neutral SDK for Navide Plugin Platform v2 activation and
typed capability calls.

The package also provides the small external workflow CLI:

```text
navide-plugin validate <directory>
navide-plugin package <directory> [--out <file>]
```

The Issue 06 package CLI remains frontend-only and rejects author backend
packaging. The SDK now also exposes the framework-neutral package-local backend
client used by the bundled Plans B5 spike; runtime activation, subscriptions,
signing, publishing, and Host transport remain Navide responsibilities.
