# providers/

This directory contains custom React context providers used to inject
cross-cutting concerns into the component tree.

## When to add a provider here

- Wrapping a third-party SDK (analytics, feature flags, auth, etc.)
- Sharing state that cannot live in Zustand (e.g. DOM-level contexts)
- Bridging with an external host app (e.g. Single-SPA shell)

## Example structure

```
providers/
└── AnalyticsProvider/
    ├── provider.tsx   # Context + Provider implementation
    └── index.ts       # Barrel export
```

Then register it in `src/App.tsx` alongside the other providers.
