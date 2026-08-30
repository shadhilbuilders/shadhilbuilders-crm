# @shadhil/ui-tokens

Brand tokens + IBM Plex Sans for Shadhil Builders CRM. Brand colors: navy `#001a4c`, green `#62b132`, off-white `#f8f5ef`. Single source of truth for compliance footer text. Apps import `@shadhil/ui-tokens/tokens.css` and `@shadhil/ui-tokens/fonts.css`.

## What's inside

- **`src/tokens.css`** — CSS custom properties for brand (`--color-brand-primary` etc.) plus a Tailwind v4 `@theme inline` block that mirrors them into the Tailwind namespace (`bg-primary`, `text-foreground`, `border-input`, …). Brand colors are locked; do not introduce raw hex anywhere else in the codebase.
- **`src/fonts.css`** — IBM Plex Sans 400/500/600/700 via Google Fonts. Inter and Geist are explicitly excluded per plan §4.
- **`src/compliance.ts`** — `getReraInfo`, `getCmdaInfo`, `formatReraFooter`, `formatComplianceFooter`. Reads `NEXT_PUBLIC_RERA_NUMBER`, `NEXT_PUBLIC_RERA_VALID_FROM`, `NEXT_PUBLIC_RERA_VALID_UNTIL`, `NEXT_PUBLIC_CMDA_NUMBER` and validates with zod. Used by all 4 surfaces (web footer, WhatsApp templates, push titles, landing site).

## Usage

```css
/* app/globals.css */
@import '@shadhil/ui-tokens/fonts.css';
@import '@shadhil/ui-tokens/tokens.css';
```

```ts
import {
  formatReraFooter,
  formatComplianceFooter,
} from '@shadhil/ui-tokens/compliance';

footer.textContent = formatReraFooter(); // "RERA TN/29/2017 | Valid 2026-01-01 to 2027-12-31"
```

## Required env

```bash
NEXT_PUBLIC_RERA_NUMBER=TN/29/2017
NEXT_PUBLIC_RERA_VALID_FROM=2026-01-01
NEXT_PUBLIC_RERA_VALID_UNTIL=2027-12-31
NEXT_PUBLIC_CMDA_NUMBER=CMDA/2024/0381
```

Any surface (web, mobile, backend console) that calls `getReraInfo()` / `formatReraFooter()` without these env vars set will throw at boot — by design.