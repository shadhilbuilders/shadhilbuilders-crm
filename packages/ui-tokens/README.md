# @shadhil/ui-tokens

CSS brand tokens for shadhil-crm and any future PaalStack project. Built
on the [shadcn theming convention](https://ui.shadcn.com/docs/theming)
using OKLCH color space. Inter is the brand font (loaded via
`next/font` in each consuming app — see "Font setup" below).

## Files in this package

| File | What it is | When you touch it |
|---|---|---|
| `src/brand.css` | Per-project brand overrides. The only file you edit when starting a new project. | **Every new project.** ~25 lines. |
| `src/fonts.css` | Deprecated placeholder. The brand font (Inter) is now configured in each consuming app via `next/font`. See "Font setup" below. | Not touched. Kept as a placeholder so existing imports don't break. |
| `src/compliance.ts` | RERA / CMDA compliance helpers (Zod schemas). | When extending the compliance contract. |
| `src/index.ts` | Barrel: exports compliance helpers only. | When adding new exports. |

## Where the default values come from

This package used to ship `defaults.css` (a vendored copy of shadcn's
default `:root`/`.dark` blocks). It was deleted in favor of importing
`@paalstack/react-ui/base.css` directly — the library already ships the
same shadcn defaults, vendored and kept up-to-date with the library
version. One source of truth, automatic updates on `pnpm install`.

## The cascade (in `apps/web/src/styles/globals.css`)

```css
@import '@paalstack/react-ui/all.css';       /* shadcn defaults + theme + utilities + toast */
@import '@shadhil/ui-tokens/brand.css';      /* YOUR overrides — last :root wins */
@import 'tailwindcss';

@source '../../node_modules/@paalstack/react-ui';

@theme inline {
  --font-sans: var(--font-inter, system-ui, sans-serif); /* Inter brand font */
}
```

The library's `all.css` provides every token, the `@custom-variant dark`
trigger, the 5 Base UI data-state variants, the `@theme inline` mapping
(`--color-X` → utility classes), the custom Tailwind utilities
(`ps-step`, `animate-caret-blink`, `native`, accordion keyframes), and
the sonner toast close-button rules. `brand.css` overrides only the
slots you change. Last `:root` declaration wins for CSS variables.

## Setting the brand for a new project

### 1. Pick 3 colors and convert to OKLCH

You need exactly three brand values:

- **Primary** — the main call-to-action / brand color (used for `--primary`)
- **Secondary** — the accent / brand secondary (used for `--secondary`)

Convert each hex value to OKLCH. Quick way:

```bash
node -e '
function hexToRgb(h){h=h.replace("#","");return[parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]}
function rgbToLinear(c){c/=255;return c<=0.04045?c/12.92:Math.pow((c+0.055)/1.055,2.4)}
function oklabToOklch(L,a,b){const C=Math.sqrt(a*a+b*b);let H=Math.atan2(b,a)*180/Math.PI;if(H<0)H+=360;return[L,C,H]}
function hexToOklch(hex){const[r,g,b]=hexToRgb(hex);const rL=rgbToLinear(r),gL=rgbToLinear(g),bL=rgbToLinear(b);const l=0.4122214708*rL+0.5363325363*gL+0.0514459929*bL;const m=0.2119034982*rL+0.6806995451*gL+0.1073969566*bL;const s=0.0883024619*rL+0.2817188376*gL+0.6299787005*bL;const l_=Math.cbrt(l),m_=Math.cbrt(m),s_=Math.cbrt(s);const L=0.2104542553*l_+0.7936177850*m_-0.0040720468*s_;const a=1.9779984951*l_-2.4285922050*m_+0.4505937099*s_;const bb=0.0259040371*l_+0.7827717662*m_-0.8086757660*s_;return oklabToOklch(L,a,bb)}
const c=process.argv[1];const[L,C,H]=hexToOklch(c);console.log(`oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})`)
' "#001a4c"
# → oklch(0.238 0.099 260.3)
```

Or use https://oklch.com.

### 2. Edit `brand.css`

Open `src/brand.css` and update the three values in `:root`:

```css
:root {
  --primary: oklch(0.238 0.099 260.3);     /* YOUR primary */
  --primary-foreground: oklch(0.971 0.009 84.6); /* contrast color (white-ish or black-ish) */
  --ring: var(--primary);

  --secondary: oklch(0.684 0.178 136.1);   /* YOUR secondary */
  --secondary-foreground: oklch(0.145 0 0);

  --accent: var(--secondary);
  --accent-foreground: var(--secondary-foreground);

  --background: oklch(0.971 0.009 84.6);   /* YOUR surface */
  --foreground: oklch(0.238 0.099 260.3);  /* text color on the surface */
  /* ...rest cascades from base.css */
}
```

For the `.dark` block: shadcn convention is to **invert** the primary in
dark mode (e.g. light gray primary on dark surfaces) for contrast. If you
want your brand primary to stay the same in both modes, override both
`:root` and `.dark` with the same value. If you want the standard
shadcn-style inversion, leave the `.dark` block as the defaults suggest.

### 3. Done

The rest of the token contract (radius scale, chart palette, destructive
color, popover, card, borders, info/warning/success/danger, etc.)
inherits from `all.css` (via the library) without any further changes.
The `@theme inline` block in `globals.css` maps them to Tailwind
utilities (`bg-primary`, `text-foreground`, `border-border`, etc.).

## Font setup (Inter via `next/font`)

Inter is loaded per-app via `next/font/google`. Add this to the root
layout of each consuming app:

```tsx
// apps/web/src/app/layout.tsx
import { Inter } from 'next/font/google';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={cn(inter.variable, 'antialiased font-sans')}>
        {children}
      </body>
    </html>
  );
}
```

The `inter.variable` class sets `--font-inter` on `<body>`. Tailwind's
`font-sans` utility then resolves to `var(--font-sans)` (declared in
`globals.css` as `var(--font-inter, system-ui, sans-serif)` — see the
cascade example above).

**Why `next/font` instead of `@font-face` in CSS:**
- Self-hosted: font files are downloaded once at build time and served
  from your domain (no third-party Google Fonts CDN request)
- Preloaded with `<link rel="preload">` (no FOIT/FOUT flash)
- Privacy-friendly (no third-party tracking)

## For non-Next.js projects (mobile, backend, Storybook)

The `brand.css` pattern works in any project that uses Tailwind v4.
For the font:

- **React Native (Expo)**: import via a StyleSheet.create or a CSS-in-JS
  adapter; the `oklch()` values need a polyfill on iOS < 16.4 / Android
  < 12 (use a CSS-to-RN transformer that handles the conversion).
- **Plain HTML / static sites**: drop the same `@import` chain into a
  stylesheet and the same `bg-primary` etc. utilities work via Tailwind
  CDN. Add a Google Fonts `<link>` for Inter (or whatever brand font).
- **Storybook**: import `brand.css` in `.storybook/preview.ts` via the
  `parameters.backgrounds` config so the shadcn-decorator tree renders
  in your brand colors. Import `@paalstack/react-ui/all.css` the same
  way for the default palette fallback.

## Related

- shadcn theming docs: https://ui.shadcn.com/docs/theming
- OKLCH picker: https://oklch.com
- Tailwind v4 `@theme` directive: https://tailwindcss.com/docs/theme
- `@paalstack/react-ui/all.css` — the library's vendored shadcn
  defaults + theme mapping + utilities + toast rules (we import this;
  the project doesn't need to maintain its own copy)
